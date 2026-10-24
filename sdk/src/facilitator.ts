import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import {
  createWalletClient,
  publicActions,
  type Account,
  type Chain,
  type Hash,
  type Hex,
  type LocalAccount,
  type PublicActions,
  type Transport,
  type WalletClient,
} from "viem";
import { NETWORKS, type SekishoNetwork } from "./chains.js";
import { createSekishoTransport } from "./transport.js";

export interface SekishoFacilitatorOptions {
  /** Wallet que envía las transacciones de liquidación (paga el gas en AVAX). */
  account: LocalAccount;
  network?: SekishoNetwork;
  /** RPC propia (o lista). Las públicas de la red quedan como respaldo. */
  rpcUrl?: string | readonly string[];
}

/**
 * Tope de gas por transacción de liquidación. transferWithAuthorization usa ~103k;
 * el tope deja margen para despliegues de wallets ERC-6492.
 */
export const SETTLEMENT_GAS_CAP = 1_000_000n;

/**
 * Límite de gas para liquidar: estimación + 20 %, nunca por encima del tope.
 * Protege contra RPCs que devuelven estimaciones absurdas (el nodo rechazaría la tx
 * con "exceeds block gas limit").
 */
export function settlementGasLimit(estimated: bigint, cap: bigint = SETTLEMENT_GAS_CAP): bigint {
  const padded = (estimated * 12n) / 10n;
  return padded > cap ? cap : padded;
}

type SettlementClient = WalletClient<Transport, Chain, Account> & PublicActions<Transport, Chain, Account>;

interface ContractWrite {
  address: Hex;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  gas?: bigint;
  dataSuffix?: Hex;
}

/** writeContract con gas estimado y acotado (el que usa el facilitator para liquidar). */
export async function writeContractWithGasCap(client: SettlementClient, request: ContractWrite): Promise<Hash> {
  const call = request as any;
  const gas = request.gas ?? settlementGasLimit(await client.estimateContractGas(call));
  return client.writeContract({ ...call, gas });
}

/** sendTransaction con gas estimado y acotado (despliegues ERC-6492). */
export async function sendTransactionWithGasCap(
  client: SettlementClient,
  request: { to: Hex; data: Hex }
): Promise<Hash> {
  const gas = settlementGasLimit(await client.estimateGas({ account: client.account, ...request }));
  return client.sendTransaction({ account: client.account, chain: client.chain, ...request, gas });
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
    transport: createSekishoTransport(config, options.rpcUrl),
  }).extend(publicActions);

  type VerifyTypedDataArgs = Parameters<typeof viemClient.verifyTypedData>[0];

  const signer = toFacilitatorEvmSigner({
    address: options.account.address,
    getCode: viemClient.getCode,
    readContract: viemClient.readContract,
    // Adaptador: misma llamada en runtime, solo ajusta el tipo para TypeScript
    verifyTypedData: (args) => viemClient.verifyTypedData(args as VerifyTypedDataArgs),
        // Gas estimado con tope: una RPC con una estimación absurda no tumba la liquidación
        writeContract: (args) => writeContractWithGasCap(viemClient, args),
        sendTransaction: (args) => sendTransactionWithGasCap(viemClient, args),
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