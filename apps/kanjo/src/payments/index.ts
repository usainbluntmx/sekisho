import type { PaymentMethod } from "./types.js";
import { usdcSekisho } from "./usdc-sekisho.js";

export type { PaymentMethod, PaymentQuote } from "./types.js";

/** Métodos de pago disponibles. En la v2 se agrega aquí el método fiat. */
const METHODS: Record<string, PaymentMethod> = {
  [usdcSekisho.id]: usdcSekisho,
};

export const DEFAULT_PAYMENT_METHOD = usdcSekisho.id;

export function getPaymentMethod(id: string = DEFAULT_PAYMENT_METHOD): PaymentMethod {
  const method = METHODS[id];
  if (!method) throw new Error(`Método de pago no soportado: ${id}`);
  return method;
}