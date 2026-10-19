import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { parseUnits, type LocalAccount } from "viem";
import { NETWORKS, type SekishoNetwork } from "./chains.js";

export interface SekishoFetchOptions {
  /** Cuenta del agente que firma los pagos (viem LocalAccount). */
  account: LocalAccount;
  network?: SekishoNetwork;
  /** Máximo a pagar por petición, en USD. Por defecto "1". */
  maxPerPayment?: string;
}

export interface SekishoFetch {
  /** fetch que paga automáticamente cuando recibe un 402. */
  fetch: typeof fetch;
  /** Utilidad oficial de x402 para leer el resultado del pago. */
  httpClient: x402HTTPClient;
}

/**
 * Crea un fetch con pagos x402 para agentes.
 * Autoriza el USDC de la red de Sekisho y aplica un tope por pago.
 */
export function createSekishoFetch(options: SekishoFetchOptions): SekishoFetch {
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

  return {
    fetch: wrapFetchWithPayment(fetch, client) as typeof fetch,
    httpClient: new x402HTTPClient(client),
  };
}