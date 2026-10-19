import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { createWalletClient, http, publicActions, type LocalAccount } from "viem";
import { NETWORKS, type SekishoNetwork } from "./chains.js";

export interface SekishoFacilitatorOptions {
  /** Wallet que envía las transacciones de liquidación (paga el gas en AVAX). */
  account: LocalAccount;
  network?: SekishoNetwork;
  rpcUrl?: string;
}

/** Tipo que acepta x402ResourceServer como facilitator. */
export type SekishoFacilitatorClient = NonNullable<
  ConstructorParameters<typeof x402ResourceServer>[0]
>;

/**
 * Facilitator x402 en el mismo proceso (self-facilitation).
 * Verifica y liquida pagos EIP-3009 directamente en Avalanche,
 * sin depender de un servicio externo.
 */
export function createSekishoFacilitator(options: SekishoFacilitatorOptions): x402Facilitator {
  const network = options.network ?? "avalancheFuji";
  const config = NETWORKS[network];

  const viemClient = createWalletClient({
    account: options.account,
    chain: config.chain,
    transport: http(options.rpcUrl ?? config.rpcUrl),
  }).extend(publicActions);

  type VerifyTypedDataArgs = Parameters<typeof viemClient.verifyTypedData>[0];

  const signer = toFacilitatorEvmSigner({
    address: options.account.address,
    getCode: viemClient.getCode,
    readContract: viemClient.readContract,
    // Adaptador: misma llamada en runtime, solo ajusta el tipo para TypeScript
    verifyTypedData: (args) => viemClient.verifyTypedData(args as VerifyTypedDataArgs),
    writeContract: viemClient.writeContract,
    sendTransaction: viemClient.sendTransaction,
    waitForTransactionReceipt: viemClient.waitForTransactionReceipt,
  });

  const facilitator = new x402Facilitator();
  registerExactEvmScheme(facilitator, {
    signer,
    networks: `eip155:${config.chain.id}`,
  });

  return facilitator;
}

/**
 * Convierte el facilitator local en el cliente que espera x402ResourceServer.
 * En runtime solo enlaza verify/settle/getSupported; el cast ajusta el tipo
 * de `network` (string → formato CAIP-2), que es idéntico en valor.
 */
export function toFacilitatorClient(facilitator: x402Facilitator): SekishoFacilitatorClient {
  return {
    verify: facilitator.verify.bind(facilitator),
    settle: facilitator.settle.bind(facilitator),
    getSupported: async () => facilitator.getSupported(),
  } as SekishoFacilitatorClient;
}