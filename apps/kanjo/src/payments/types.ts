import type { Order, Store } from "../store.js";

/** Lo que el cliente debe pagar para un pedido, según el método. */
export interface PaymentQuote {
  orderId: string;
  methodId: string;
  /** Monto en unidades atómicas de USDC (6 decimales). */
  amountAtomic: number;
  currency: "USDC";
  /** Datos específicos del método (por ejemplo, la opción de pago x402). */
  details: unknown;
}

/**
 * Método de pago de Kanjō.
 * v1: USDC en Avalanche vía Sekisho. v2: SPEI/tarjeta vía on-ramp al mismo vault.
 */
export interface PaymentMethod {
  id: string;
  label: string;
  /** Prepara el cobro de un pedido: qué cobrar y a dónde. */
  createQuote(order: Order, store: Store): Promise<PaymentQuote>;
  /** Acciones después de un pago confirmado (por ejemplo, repartir el vault). */
  afterPaid?(order: Order, store: Store, paymentTx: string): Promise<void>;
}