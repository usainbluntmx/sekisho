import { parseUnits } from "viem";

export interface DistributionPolicy {
  /** Reparte en cuanto el saldo pendiente alcanza este monto (atómico, 6 decimales). */
  minAtomic: bigint;
  /** Reparte aunque no se alcance el mínimo si el pago más antiguo tiene estas horas… */
  maxHours: number;
  /** …siempre que lo pendiente sea al menos esto: debajo, el gas cuesta más que la comisión. */
  ageMinAtomic: bigint;
  /** Tope de espera: pasado este plazo se reparte cualquier monto, para no retener al vendedor. */
  staleHours: number;
  /** Si hay una SUBIDA de fee programada, reparte todo lo pendiente cuando falten estas horas o menos. */
  feeChangeHours: number;
}

export interface VaultState {
  pendingAtomic: bigint;
  /** Horas del pago más antiguo sin repartir, o null si no hay registro. */
  oldestUndistributedHours: number | null;
    /** Cambio de fee programado en la factory (null si no hay). */
    feeChange?: { hoursLeft: number; increase: boolean } | null;
}

export type Decision =
  | { distribute: true; reason: "threshold" | "max_age" | "stale" | "forced" | "fee_change" }
  | { distribute: false; reason: "empty" | "waiting" | "fee_change_pending" };

export function decide(state: VaultState, policy: DistributionPolicy, force = false): Decision {
  if (state.pendingAtomic === 0n) return { distribute: false, reason: "empty" };
  if (force) return { distribute: true, reason: "forced" };
  // Protección: lo cobrado se reparte con el fee vigente antes de que aplique una subida
  if (state.feeChange?.increase && state.feeChange.hoursLeft <= policy.feeChangeHours) {
    return { distribute: true, reason: "fee_change" };
  }
  if (state.pendingAtomic >= policy.minAtomic) return { distribute: true, reason: "threshold" };
  const hours = state.oldestUndistributedHours;
  if (hours !== null && hours >= policy.staleHours) return { distribute: true, reason: "stale" };
  if (hours !== null && hours >= policy.maxHours && state.pendingAtomic >= policy.ageMinAtomic) {
    return { distribute: true, reason: "max_age" };
  }
  return { distribute: false, reason: "waiting" };
}

export function policyFromEnv(): DistributionPolicy {
  return {
    minAtomic: parseUnits(process.env.DISTRIBUTE_MIN_USDC ?? "5", 6),
    maxHours: Number(process.env.DISTRIBUTE_MAX_HOURS ?? 24),
    ageMinAtomic: parseUnits(process.env.DISTRIBUTE_AGE_MIN_USDC ?? "0.25", 6),
    staleHours: Number(process.env.DISTRIBUTE_STALE_HOURS ?? 168),
    feeChangeHours: Number(process.env.DISTRIBUTE_FEE_CHANGE_HOURS ?? 48),
  };
}