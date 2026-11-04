import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import type { x402Facilitator } from "@x402/core/facilitator";
import { NETWORKS, type SekishoClient } from "@zero-two-labs/sekisho";

/**
 * Piezas para probar clientes x402 de terceros sin tocar la cadena:
 * la app real de la demo, con un cliente de Sekisho simulado y un facilitador
 * ESTRICTO que verifica la firma EIP-3009 como lo haría el contrato de USDC.
 * Si un cliente firma mal (dominio, tipos, montos, destino), aquí falla igual que on-chain.
 */
export const FUJI = NETWORKS.avalancheFuji;
export const MERCHANT = "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae" as const;
export const VAULT = "0x449d38883418c750DFF8D1a4DF183d6A276789a0" as const;

export function fakeSekisho(): SekishoClient {
  let pending = 0n;
  return {
    network: "avalancheFuji",
    config: FUJI,
    getPayTo: async () => VAULT,
    getConfig: async () => ({ feeBps: 150, feeChange: null }),
    pending: async () => ({ vault: VAULT, deployed: true, total: pending, fee: 0n, merchantAmount: pending }),
    distribute: async () => {
      pending = 0n;
      return `0x${"dd".repeat(32)}`;
    },
  } as unknown as SekishoClient;
}

const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export interface VerifiedPayment {
  payer: Address;
  to: Address;
  value: bigint;
  nonce: Hex;
}

export function strictFacilitator(onSettled?: (payment: VerifiedPayment) => void) {
  const usedNonces = new Set<string>();
  const calls = { verify: 0, settle: 0, rejected: [] as string[] };

  async function check(payload: any, requirements: any): Promise<{ ok: true; payment: VerifiedPayment } | { ok: false; reason: string }> {
    const auth = payload?.payload?.authorization;
    const signature = payload?.payload?.signature as Hex | undefined;
    if (!auth || !signature) return { ok: false, reason: "payload sin authorization o signature (exact/EVM)" };
    if (payload.x402Version !== 2) return { ok: false, reason: `x402Version ${payload.x402Version}, se esperaba 2` };
    if (getAddress(auth.to) !== getAddress(requirements.payTo)) return { ok: false, reason: "to no es el payTo (vault)" };
    if (BigInt(auth.value) !== BigInt(requirements.amount)) return { ok: false, reason: `value ${auth.value} ≠ amount ${requirements.amount}` };
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(auth.validAfter) > now) return { ok: false, reason: "validAfter en el futuro" };
    if (BigInt(auth.validBefore) <= now) return { ok: false, reason: "autorización vencida (validBefore)" };
    if (usedNonces.has(String(auth.nonce).toLowerCase())) return { ok: false, reason: "nonce ya usado" };

    const valid = await verifyTypedData({
      address: getAddress(auth.from),
      domain: {
        name: requirements.extra?.name,
        version: requirements.extra?.version,
        chainId: Number(String(requirements.network).split(":")[1]),
        verifyingContract: getAddress(requirements.asset),
      },
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(auth.from),
        to: getAddress(auth.to),
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature,
    });
    if (!valid) return { ok: false, reason: "firma EIP-712 inválida para el dominio de USDC" };
    return { ok: true, payment: { payer: getAddress(auth.from), to: getAddress(auth.to), value: BigInt(auth.value), nonce: auth.nonce } };
  }

  const facilitator = {
    verify: async (payload: any, requirements: any) => {
      calls.verify++;
      const result = await check(payload, requirements);
      if (!result.ok) {
        calls.rejected.push(result.reason);
        return { isValid: false, invalidReason: result.reason, payer: payload?.payload?.authorization?.from };
      }
      return { isValid: true, payer: result.payment.payer };
    },
    settle: async (payload: any, requirements: any) => {
      calls.settle++;
      const result = await check(payload, requirements);
      if (!result.ok) {
        calls.rejected.push(result.reason);
        return { success: false, errorReason: result.reason, transaction: "", network: requirements.network, payer: payload?.payload?.authorization?.from };
      }
      usedNonces.add(String(result.payment.nonce).toLowerCase());
      onSettled?.(result.payment);
      return { success: true, transaction: `0x${"cd".repeat(32)}`, network: requirements.network, payer: result.payment.payer };
    },
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:43113" }], extensions: [], signers: {} }),
  } as unknown as x402Facilitator;

  return { facilitator, calls };
}
