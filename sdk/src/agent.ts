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
}

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

  return x402Client.fromConfig({
    schemes: [{ network: caip2, client: new ExactEvmScheme(options.account) }],
    spendControls: {
      allowedAssets: [
        { network: caip2, asset: config.usdc, maxAmountPerPayment: maxAtomic },
      ],
    },
  });
}

/** fetch con pagos x402 automáticos. */
export function createSekishoFetch(options: SekishoAgentOptions): SekishoFetch {
  const client = createSekishoPaymentClient(options);
  return {
    fetch: wrapFetchWithPayment(fetch, client) as typeof fetch,
    httpClient: new x402HTTPClient(client),
  };
}