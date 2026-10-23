import { parseUnits, type Address } from "viem";
import type { SekishoClient } from "./client.js";

/**
 * Facilitator x402 v2 externo con soporte para Avalanche.
 * @deprecated Su RPC de Fuji falló de forma persistente en pruebas. Usa
 * `createSekishoFacilitator` (self-facilitation). Se eliminará en 0.2.0.
 */
export const DEFAULT_FACILITATOR_URL = "https://facilitator.ultravioletadao.xyz";

export interface PaymentOptionParams {
  /** Wallet del vendedor (dueño del vault). */
  merchant: Address;
  /** Precio en USD como texto, por ejemplo "0.01". */
  price: string;
}

/** Opción de pago x402 v2 (esquema exact) lista para usar en `accepts`. */
export interface SekishoPaymentOption {
  scheme: "exact";
  network: `eip155:${number}`;
  payTo: Address;
  price: {
    amount: string;
    asset: Address;
    extra: { name: string; version: string };
  };
}

/**
 * Construye la opción de pago x402 de un vendedor.
 * El payTo es el SplitVault del vendedor, así que el fee de Sekisho
 * se aplica automáticamente al repartir.
 */
export async function createPaymentOption(
  sekisho: SekishoClient,
  params: PaymentOptionParams
): Promise<SekishoPaymentOption> {
  const amount = parseUnits(params.price, 6);
  if (amount <= 0n) {
    throw new Error("Sekisho: el precio debe ser mayor a 0");
  }

  const payTo = await sekisho.getPayTo(params.merchant);

  return {
    scheme: "exact",
    network: `eip155:${sekisho.config.chain.id}`,
    payTo,
    price: {
      amount: amount.toString(),
      asset: sekisho.config.usdc,
      extra: { ...sekisho.config.usdcEip712 },
    },
  };
}