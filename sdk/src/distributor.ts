import { formatUnits, getAddress, parseUnits, type Address, type Hash } from "viem";
import type { SekishoClient } from "./client.js";

/**
 * Cuándo repartir un vault. Repartir cuesta gas a quien llama distribute(),
 * así que se agrupan los pagos en lugar de repartir uno por uno.
 */
export interface DistributionPolicy {
  /** Reparte en cuanto lo pendiente alcanza este monto (USDC). Por defecto "5". */
  minUsdc: string;
  /** Reparte montos menores cuando el pago más antiguo cumple estas horas… Por defecto 24. */
  maxHours: number;
  /**
   * …siempre que lo pendiente sea al menos esto (USDC). Por defecto "0.25".
   * Es el piso de todo reparto automático: debajo, el gas cuesta más de lo que se reparte.
   */
  ageMinUsdc: string;
  /**
   * Si hay una SUBIDA de fee programada, reparte lo pendiente (sobre el piso) cuando falten
   * estas horas o menos, para que lo cobrado se reparta con el fee anterior. Por defecto 48.
   */
  feeChangeHours: number;
}

export const DEFAULT_DISTRIBUTION_POLICY: Readonly<DistributionPolicy> = Object.freeze({
  minUsdc: "5",
  maxHours: 24,
  ageMinUsdc: "0.25",
  feeChangeHours: 48,
});

export interface VaultState {
  /** Saldo pendiente de repartir (atómico, 6 decimales). */
  pendingAtomic: bigint;
  /** Horas desde el pago más antiguo sin repartir, o null si no se sabe. */
  oldestPendingHours: number | null;
  /** Cambio de fee programado (null si no hay). */
  feeChange?: { hoursLeft: number; increase: boolean } | null;
}

export type DistributionReason = "threshold" | "max_age" | "fee_change" | "forced";

export type DistributionDecision =
  | { distribute: true; reason: DistributionReason }
  | { distribute: false; reason: "empty" | "waiting" };

/** Decisión pura: no toca la red. */
export function decideDistribution(
  state: VaultState,
  policy: DistributionPolicy = DEFAULT_DISTRIBUTION_POLICY,
  force = false
): DistributionDecision {
  if (state.pendingAtomic === 0n) return { distribute: false, reason: "empty" };
  if (force) return { distribute: true, reason: "forced" };

  const minAtomic = parseUnits(policy.minUsdc, 6);
  const floorAtomic = parseUnits(policy.ageMinUsdc, 6);

  if (state.pendingAtomic >= minAtomic) return { distribute: true, reason: "threshold" };
  // Debajo del piso nunca se reparte solo (ni por edad ni por cambio de fee)
  if (state.pendingAtomic < floorAtomic) return { distribute: false, reason: "waiting" };

  if (state.feeChange?.increase && state.feeChange.hoursLeft <= policy.feeChangeHours) {
    return { distribute: true, reason: "fee_change" };
  }
  const hours = state.oldestPendingHours;
  if (hours !== null && hours >= policy.maxHours) return { distribute: true, reason: "max_age" };
  return { distribute: false, reason: "waiting" };
}

export interface DistributionEvent {
  merchant: Address;
  tx: Hash;
  /** Total repartido y fee de la plataforma (atómico, 6 decimales). */
  total: bigint;
  fee: bigint;
  reason: DistributionReason;
}

export interface DistributionResult {
  merchant: Address;
  decision: DistributionDecision;
  /** Pendiente en USDC legible, o "?" si falló la lectura. */
  pending: string;
  tx?: Hash;
  error?: string;
}

export interface SekishoDistributorOptions {
  /** Cliente con `account`: quien reparte paga el gas de distribute(). */
  sekisho: SekishoClient;
  /** Vendedores a revisar (lista fija o función, por ejemplo una consulta a tu base). */
  merchants: readonly Address[] | (() => readonly Address[] | Promise<readonly Address[]>);
  policy?: Partial<DistributionPolicy>;
  /** Minutos entre revisiones con start(). Por defecto 15. */
  intervalMinutes?: number;
  onDistributed?: (event: DistributionEvent) => void | Promise<void>;
  onError?: (error: unknown, merchant?: Address) => void;
  /** Bitácora. Por defecto console.log; pasa `() => {}` para silenciarla. */
  log?: (message: string) => void;
}

export interface SekishoDistributor {
  readonly policy: Readonly<DistributionPolicy>;
  /** Registra un pago liquidado (llámalo en onAfterSettle) para medir su antigüedad. */
  notePayment(merchant: Address, at?: Date): void;
  /**
   * Revisa cada vendedor y reparte si la política lo indica. Si ya hay una revisión en curso,
   * devuelve [] y programa otra al terminar la actual (un pago nuevo nunca se queda sin revisar).
   */
  check(options?: { force?: boolean }): Promise<DistributionResult[]>;
  /** Revisión periódica; la primera corre de inmediato. */
  start(): void;
  stop(): void;
}

/**
 * Repartidor automático (keeper) para uno o varios vendedores.
 *
 * La antigüedad de lo pendiente se lleva en memoria: tras reiniciar el proceso,
 * cuenta desde la primera revisión que encuentra saldo (nunca reparte antes de tiempo).
 */
export function createSekishoDistributor(options: SekishoDistributorOptions): SekishoDistributor {
  const policy: Readonly<DistributionPolicy> = Object.freeze({
    ...DEFAULT_DISTRIBUTION_POLICY,
    ...options.policy,
  });
  // Valida montos al crear, no en la primera revisión
  parseUnits(policy.minUsdc, 6);
  parseUnits(policy.ageMinUsdc, 6);

  const { sekisho } = options;
  const log = options.log ?? ((message: string) => console.log(message));
  const onError =
    options.onError ??
    ((error: unknown, merchant?: Address) =>
      log(`[sekisho] Reparto${merchant ? ` de ${merchant}` : ""} falló, se reintenta en la próxima revisión: ${errorMessage(error)}`));
  const firstPendingAt = new Map<Address, number>();
  let running = false;
  let rerun = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function notePayment(merchant: Address, at: Date = new Date()): void {
    const key = getAddress(merchant);
    const current = firstPendingAt.get(key);
    if (current === undefined || at.getTime() < current) firstPendingAt.set(key, at.getTime());
  }

  async function listMerchants(): Promise<Address[]> {
    const list = typeof options.merchants === "function" ? await options.merchants() : options.merchants;
    return [...new Set(list.map((merchant) => getAddress(merchant)))];
  }

  async function check({ force = false }: { force?: boolean } = {}): Promise<DistributionResult[]> {
    if (running) {
      rerun = true;
      return [];
    }
    running = true;
    try {
      let merchants: Address[];
      let feeChange: VaultState["feeChange"] = null;
      try {
        merchants = await listMerchants();
        const config = await sekisho.getConfig();
        if (config.feeChange) {
          feeChange = {
            hoursLeft: (config.feeChange.effectiveAt.getTime() - Date.now()) / 3_600_000,
            increase: config.feeChange.feeBps > config.feeBps,
          };
        }
      } catch (error) {
        onError(error);
        return [];
      }

      const results: DistributionResult[] = [];
      for (const merchant of merchants) {
        try {
          const pending = await sekisho.pending(merchant);
          if (pending.total === 0n) {
            firstPendingAt.delete(merchant);
          } else if (!firstPendingAt.has(merchant)) {
            firstPendingAt.set(merchant, Date.now());
          }
          const since = firstPendingAt.get(merchant);
          const decision = decideDistribution(
            {
              pendingAtomic: pending.total,
              oldestPendingHours: since === undefined ? null : (Date.now() - since) / 3_600_000,
              feeChange,
            },
            policy,
            force
          );
          const result: DistributionResult = { merchant, decision, pending: formatUnits(pending.total, 6) };

          if (decision.distribute) {
            const tx = await sekisho.distribute(merchant);
            firstPendingAt.delete(merchant);
            result.tx = tx;
            log(
              `[sekisho] Reparto de ${result.pending} USDC de ${merchant} (${decision.reason}) → ${sekisho.config.explorer}/tx/${tx}`
            );
            await options.onDistributed?.({ merchant, tx, total: pending.total, fee: pending.fee, reason: decision.reason });
          }
          results.push(result);
        } catch (error) {
          onError(error, merchant);
          results.push({
            merchant,
            decision: { distribute: false, reason: "waiting" },
            pending: "?",
            error: errorMessage(error),
          });
        }
      }
      return results;
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        void check().catch((error) => onError(error));
      }
    }
  }

  function start(): void {
    if (timer) return;
    const minutes = options.intervalMinutes ?? 15;
    if (!(minutes > 0)) throw new Error("intervalMinutes debe ser mayor que 0");
    const tick = () => void check().catch((error) => onError(error));
    timer = setInterval(tick, minutes * 60_000);
    timer.unref?.();
    tick();
    log(
      `[sekisho] Repartidor activo: revisión cada ${minutes} min ` +
        `(≥ ${policy.minUsdc} USDC, o ${policy.maxHours} h con ≥ ${policy.ageMinUsdc} USDC)`
    );
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return { policy, notePayment, check, start, stop };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
