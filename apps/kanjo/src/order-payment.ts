/**
 * Cobro de un pedido, compartido por todos los canales de pago (checkout web y MCP):
 * mismas validaciones, mismo candado de liquidación y mismo registro.
 */
import {
  getOrder,
  getStockShortages,
  getStore,
  markOrderPaid,
  recordPayment,
  type PaymentRecord,
} from "./store.js";
import { getPaymentMethod } from "./payments/index.js";
import { sekisho, type UsdcQuoteDetails } from "./payments/usdc-sekisho.js";
import { enqueueDuplicatePayment, enqueueOrderPaid } from "./notify.js";
import { processOutbox } from "./outbox.js";
import { isSettling, tryStartSettlement } from "./settlement-guard.js";
import { safeEqual } from "./security.js";
import { checkAfterPayment } from "./distributor.js";

const EXPLORER = sekisho.config.explorer;

/** Cotización del pedido (monto exacto y vault de SU tienda). */
export async function quoteFor(orderId: string): Promise<UsdcQuoteDetails> {
  const found = getOrder(orderId);
  const store = found && getStore(found.order.store_id);
  if (!found || !store) throw new Error(`Pedido no encontrado: ${orderId}`);
  const quote = await getPaymentMethod().createQuote(found.order, store);
  return quote.details as UsdcQuoteDetails;
}

/** true si el token corresponde al pedido (sin token válido, el pedido "no existe"). */
export function hasValidToken(orderId: string, token: string): boolean {
  const found = getOrder(orderId);
  return Boolean(found?.order.pay_token && token && safeEqual(token, found.order.pay_token));
}

export interface BlockReason {
  status: 404 | 409;
  error: string;
}

/** Motivo por el que un pedido no se puede cobrar en este momento, o null si sí se puede. */
export function blockReason(orderId: string, token: string): BlockReason | null {
  if (!hasValidToken(orderId, token)) return { status: 404, error: "Pedido no encontrado." };

  const found = getOrder(orderId)!;
  if (found.order.status !== "pending_payment") {
    return { status: 409, error: "Este pedido ya fue pagado o ya no está disponible." };
  }

  if (isSettling(orderId)) {
    return { status: 409, error: "Ya hay un pago en proceso para este pedido. Espera unos segundos." };
  }

  const shortages = getStockShortages(orderId);
  if (shortages.length > 0) {
    const names = shortages.map((s) => `${s.name} (quedan ${s.available})`).join(", ");
    return {
      status: 409,
      error: `Sin stock suficiente: ${names}. Pide al asistente que ajuste tu pedido.`,
    };
  }

  return null;
}

/**
 * Justo antes de liquidar: revalida el pedido y toma el candado.
 * Devuelve el motivo si NO se debe cobrar; null si el candado quedó tomado (liberarlo con endSettlement).
 */
export function claimForSettlement(orderId: string, token: string): string | null {
  const blocked = blockReason(orderId, token);
  if (blocked) {
    console.warn(`[pago] Liquidación cancelada para ${orderId}: ${blocked.error}`);
    return blocked.error;
  }
  if (!tryStartSettlement(orderId)) return "Ya hay un pago en proceso para este pedido.";
  return null;
}

function recordSafely(payment: PaymentRecord): void {
  try {
    recordPayment(payment);
  } catch (error) {
    console.error(`[pago] No se pudo registrar el pago ${payment.tx}:`, error);
  }
}

/** Procesa la bandeja de salida en segundo plano; si falla, se registra y el worker reintenta. */
function kickOutbox(): void {
  processOutbox().catch((error) => console.error("[pago] Error al procesar avisos (el worker reintenta):", error));
}

/** Tareas posteriores al pago: reparto (según el modo) y avisos por la bandeja de salida. */
export async function afterOrderPaid(orderId: string, tx: string): Promise<void> {
  const found = getOrder(orderId);
  const store = found && getStore(found.order.store_id);
  if (!found || !store) return;

  try {
    enqueueOrderPaid(orderId);
    kickOutbox();
  } catch (error) {
    console.error("[pago] No se pudieron encolar los avisos (se recuperan al reiniciar):", error);
  }

  try {
    await getPaymentMethod().afterPaid?.(found.order, store, tx);
  } catch (error) {
    console.error("[pago] El reparto falló (el distributor lo recupera):", error);
  }

  // Por lotes: revisa la política en cuanto entra el pago (sin esperar la revisión periódica)
  checkAfterPayment(store.merchant_address as `0x${string}`);
}

export interface SettledPayment {
  tx: string;
  payer?: string;
  amountAtomic: number;
}

/**
 * Después de liquidar: el dinero ya se movió, así que esto nunca debe perder el registro.
 * Marca el pedido como pagado (o registra un pago duplicado) y lanza las tareas posteriores.
 */
export function recordSettledOrder(
  orderId: string,
  payment: SettledPayment,
  after: (orderId: string, tx: string) => Promise<void> = afterOrderPaid
): { updated: boolean } {
  const base = { tx: payment.tx, orderId, payer: payment.payer, amountAtomic: payment.amountAtomic };

  let result: ReturnType<typeof markOrderPaid>;
  try {
    result = markOrderPaid(orderId, payment.tx);
  } catch (error) {
    console.error(`[pago] CRÍTICO: el pago ${payment.tx} se liquidó pero el pedido ${orderId} no se pudo actualizar`, error);
    recordSafely({ ...base, kind: "order" });
    return { updated: false };
  }

  if (!result.updated) {
    recordSafely({ ...base, kind: "duplicate" });
    console.warn(`[pago] Pago duplicado del pedido ${orderId} → ${EXPLORER}/tx/${payment.tx}`);
    try {
      enqueueDuplicatePayment(orderId, payment.tx, base.amountAtomic);
      kickOutbox();
    } catch (error) {
      console.error("[pago] No se pudo encolar el aviso de duplicado:", error);
    }
    return { updated: false };
  }

  recordSafely({ ...base, kind: "order" });
  console.log(`[pago] Pedido ${orderId} pagado → ${EXPLORER}/tx/${payment.tx}`);
  if (result.shortages.length > 0) console.warn(`[pago] Pedido ${orderId} pagado SIN stock suficiente:`, result.shortages);

  after(orderId, payment.tx).catch((error) =>
    console.error(`[pago] Error en tareas posteriores al pago del pedido ${orderId}:`, error)
  );
  return { updated: true };
}
