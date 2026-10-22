import { formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createSekishoClient,
  createSekishoFacilitator,
  createPaymentOption,
  type SekishoPaymentOption,
} from "@zero-two-labs/sekisho";
import type { PaymentMethod, PaymentQuote } from "./types.js";
import type { Order, Store } from "../store.js";

const operatorKey = process.env.OPERATOR_PRIVATE_KEY as `0x${string}` | undefined;
if (!operatorKey) throw new Error("Falta OPERATOR_PRIVATE_KEY en .env");

/** Wallet operadora: liquida pagos x402 y ejecuta repartos (paga gas en AVAX). */
export const operator = privateKeyToAccount(operatorKey);

export const sekisho = createSekishoClient({ network: "avalancheFuji", account: operator });

/** Facilitator propio (se usa en el checkout). */
export const facilitator = createSekishoFacilitator({ account: operator, network: "avalancheFuji" });

export interface UsdcQuoteDetails {
  option: SekishoPaymentOption;
  vault: Address;
  explorer: string;
}

export const usdcSekisho: PaymentMethod = {
  id: "usdc-avalanche",
  label: "USDC en Avalanche",

  async createQuote(order: Order, store: Store): Promise<PaymentQuote> {
    if (order.status !== "pending_payment") {
      throw new Error(`El pedido ${order.id} no está pendiente de pago`);
    }

    // Precio exacto en USDC (6 decimales) a partir del total atómico
    const price = formatUnits(BigInt(order.total_atomic), 6);

    const option = await createPaymentOption(sekisho, {
      merchant: store.merchant_address as Address,
      price,
    });

    const details: UsdcQuoteDetails = {
      option,
      vault: option.payTo,
      explorer: sekisho.config.explorer,
    };

    return {
      orderId: order.id,
      methodId: this.id,
      amountAtomic: order.total_atomic,
      currency: "USDC",
      details,
    };
  },

  async afterPaid(_order: Order, store: Store): Promise<void> {
    // Por lotes (por defecto): el distributor reparte cuando conviene
    if ((process.env.DISTRIBUTE_MODE ?? "batch") !== "each") {
      console.log("[payments] Reparto programado (por lotes)");
      return;
    }

    const hash = await sekisho.distribute(store.merchant_address as Address);
    console.log(`[payments] Reparto ejecutado: ${sekisho.config.explorer}/tx/${hash}`);
  },
};