import { formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createSekishoClient,
  createSekishoFacilitator,
  createPaymentOption,
  type SekishoClient,
  type SekishoPaymentOption,
} from "@zero-two-labs/sekisho";
import type { PaymentMethod, PaymentQuote } from "./types.js";
import type { Order, Store } from "../store.js";

const operatorKey = process.env.OPERATOR_PRIVATE_KEY as `0x${string}` | undefined;
if (!operatorKey) throw new Error("Falta OPERATOR_PRIVATE_KEY en .env");

/** RPC propia (recomendada en producción). Vacío = RPC pública oficial de Fuji. */
const RPC_URL = process.env.AVALANCHE_FUJI_RPC_URL || undefined;

/** Wallet operadora: liquida pagos x402 y ejecuta repartos (paga gas en AVAX). */
export const operator = privateKeyToAccount(operatorKey);

export const sekisho = createSekishoClient({ network: "avalancheFuji", account: operator, rpcUrl: RPC_URL });

/** Facilitator propio (se usa en el checkout). */
export const facilitator = createSekishoFacilitator({
  account: operator,
  network: "avalancheFuji",
  rpcUrl: RPC_URL,
});

/** El vault de cada vendedor es determinístico: se consulta una vez y se reutiliza. */
const vaultCache = new Map<string, Address>();

async function cachedPayTo(merchant: Address): Promise<Address> {
  const key = merchant.toLowerCase();
  const cached = vaultCache.get(key);
  if (cached) return cached;
  const vault = await sekisho.getPayTo(merchant);
  vaultCache.set(key, vault);
  return vault;
}

/** Mismo cliente de Sekisho, pero con la dirección del vault cacheada. */
const quoteClient: SekishoClient = { ...sekisho, getPayTo: cachedPayTo };

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

    const option = await createPaymentOption(quoteClient, {
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