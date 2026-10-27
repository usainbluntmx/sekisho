import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { parseUnits, type LocalAccount } from "viem";
import { NETWORKS, type SekishoNetwork } from "./chains.js";

export interface SekishoAgentOptions {
  /** Cuenta del agente que firma los pagos (viem LocalAccount). */
  account: LocalAccount;
  network?: SekishoNetwork;
  /** Máximo a pagar por petición, en USD. Por defecto "1". */
  maxPerPayment?: string;
  /** Máximo acumulado durante la vida de este cliente, en USD. Sin tope si no se indica. */
  maxPerSession?: string;
  /** Máximo acumulado en cualquier ventana de 24 horas, en USD. Sin tope si no se indica. */
  maxPerDay?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** @deprecated Usa SekishoAgentOptions. Se mantiene por compatibilidad. */
export type SekishoFetchOptions = SekishoAgentOptions;

export interface SekishoFetch {
  /** fetch que paga automáticamente cuando recibe un 402. */
  fetch: typeof fetch;
  /** Utilidad oficial de x402 para leer el resultado del pago. */
  httpClient: x402HTTPClient;
}

/**
 * Cliente de pagos x402 para agentes: autoriza el USDC de la red
 * de Sekisho y aplica un tope por pago.
 */
export function createSekishoPaymentClient(options: SekishoAgentOptions): x402Client {
  const network = options.network ?? "avalancheFuji";
  const config = NETWORKS[network];
  const caip2 = `eip155:${config.chain.id}` as const;
  const maxAtomic = parseUnits(options.maxPerPayment ?? "1", 6).toString();

  const client = x402Client.fromConfig({
    schemes: [{ network: caip2, client: new ExactEvmScheme(options.account) }],
    spendControls: {
      allowedAssets: [
        { network: caip2, asset: config.usdc, maxAmountPerPayment: maxAtomic },
      ],
    },
  });

  const sessionCap = options.maxPerSession === undefined ? null : parseUnits(options.maxPerSession, 6);
  const dayCap = options.maxPerDay === undefined ? null : parseUnits(options.maxPerDay, 6);
  if (sessionCap === null && dayCap === null) return client;

  // Cada firma reserva su monto antes de crearse (dos pagos simultáneos no pueden pasar ambos el tope)
  // y la reserva se libera solo si la firma falla. Un pago firmado cuenta aunque el servidor no lo liquide.
  let sessionSpent = 0n;
  const daySpends: { at: number; amount: bigint }[] = [];
  const reservations = new WeakMap<object, { at: number; amount: bigint }>();

  const spentToday = (now: number) => {
    while (daySpends.length > 0 && daySpends[0].at <= now - DAY_MS) daySpends.shift();
    return daySpends.reduce((sum, spend) => sum + spend.amount, 0n);
  };

  client.onBeforePaymentCreation(async (context) => {
    const amount = BigInt(context.selectedRequirements.amount);
    const now = Date.now();
    if (sessionCap !== null && sessionSpent + amount > sessionCap) {
      return { abort: true, reason: `Tope de sesión alcanzado (${options.maxPerSession} USD).` };
    }
    if (dayCap !== null && spentToday(now) + amount > dayCap) {
      return { abort: true, reason: `Tope de 24 horas alcanzado (${options.maxPerDay} USD).` };
    }
    const spend = { at: now, amount };
    sessionSpent += amount;
    daySpends.push(spend);
    reservations.set(context.selectedRequirements, spend);
  });

  client.onPaymentCreationFailure(async (context) => {
    const spend = reservations.get(context.selectedRequirements);
    if (!spend) return;
    reservations.delete(context.selectedRequirements);
    sessionSpent -= spend.amount;
    const index = daySpends.indexOf(spend);
    if (index >= 0) daySpends.splice(index, 1);
  });

  return client;
}

/** fetch con pagos x402 automáticos. */
export function createSekishoFetch(options: SekishoAgentOptions): SekishoFetch {
  const client = createSekishoPaymentClient(options);
  return {
    fetch: wrapFetchWithPayment(fetch, client) as typeof fetch,
    httpClient: new x402HTTPClient(client),
  };
}