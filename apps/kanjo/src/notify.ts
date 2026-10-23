import { NETWORKS } from "@zero-two-labs/sekisho";
import { db } from "./db.js";
import { getOrder, getStore, type StockShortage } from "./store.js";
import { formatUsdc } from "./money.js";
import { enqueueNotification } from "./outbox.js";

const MERCHANT_WA_ID = process.env.MERCHANT_WA_ID ?? "";
const EXPLORER = NETWORKS.avalancheFuji.explorer;

function parseShortages(raw: string | null): StockShortage[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as StockShortage[];
  } catch {
    return [];
  }
}

function customerName(waId: string): string {
  const row = db.prepare("SELECT name FROM customers WHERE wa_id = ?").get(waId) as
    | { name: string }
    | undefined;
  return row?.name || "Sin nombre";
}

/** Encola los avisos de pedido pagado (cliente y tienda). Devuelve cuántos son nuevos. */
export function enqueueOrderPaid(orderId: string): number {
  const found = getOrder(orderId);
  if (!found || found.order.status !== "paid") return 0;

  const { order, items } = found;
  const store = getStore(order.store_id);
  const shortages = parseShortages(order.stock_issue);
  const lines = items.map((i) => `• ${i.quantity} × ${i.name}`).join("\n");
  const total = formatUsdc(order.total_atomic);
  let queued = 0;

  // 1) Cliente
  const customerWarning =
    shortages.length > 0
      ? "\n\n⚠️ Algunos productos se agotaron justo antes de tu pago. La tienda te contactará para ofrecerte un cambio o un reembolso."
      : "";

  if (
    enqueueNotification(
      `order-paid:${order.id}:customer`,
      order.customer_wa_id,
      `✅ *¡Pago recibido!*\n\nPedido *${order.id}*\n${lines}\n*Total:* ${total} USDC\n\nGracias por tu compra en ${store?.name ?? "la tienda"} 🙌${customerWarning}`
    )
  ) {
    queued++;
  }

  // 2) Tienda
  if (MERCHANT_WA_ID) {
    const merchantWarning =
      shortages.length > 0
        ? `\n\n⚠️ *Atención: pagado sin stock suficiente*\n${shortages
            .map((s) => `• ${s.name}: pidió ${s.requested}, quedaban ${s.available}`)
            .join("\n")}\nContacta al cliente para un cambio o reembolso.`
        : "";

    if (
      enqueueNotification(
        `order-paid:${order.id}:merchant`,
        MERCHANT_WA_ID,
        `🛒 *Nuevo pedido pagado* · ${order.id}\n\n${lines}\n*Total:* ${total} USDC\n*Cliente:* ${customerName(order.customer_wa_id)} (+${order.customer_wa_id})\n\nComprobante: ${EXPLORER}/tx/${order.payment_tx}${merchantWarning}`
      )
    ) {
      queued++;
    }
  }

  return queued;
}

/** Encola los avisos de un pago adicional sobre un pedido ya pagado. */
export function enqueueDuplicatePayment(orderId: string, paymentTx: string, amountAtomic: number): void {
  const found = getOrder(orderId);
  if (!found) return;

  const { order } = found;
  const amount = formatUsdc(amountAtomic);

  enqueueNotification(
    `duplicate:${paymentTx}:customer`,
    order.customer_wa_id,
    `⚠️ Recibimos un pago adicional de ${amount} USDC para tu pedido *${order.id}*, que ya estaba pagado. La tienda te lo reembolsará.`
  );

  if (MERCHANT_WA_ID) {
    enqueueNotification(
      `duplicate:${paymentTx}:merchant`,
      MERCHANT_WA_ID,
      `⚠️ *Pago duplicado* · ${order.id}\n\nSe recibió otro pago de ${amount} USDC para un pedido ya pagado.\n*Cliente:* ${customerName(order.customer_wa_id)} (+${order.customer_wa_id})\nReembolsa al cliente.\n\nComprobante: ${EXPLORER}/tx/${paymentTx}`
    );
  }
}

/**
 * Al arrancar: encola los avisos de pedidos pagados recientemente que no alcanzaron
 * a encolarse (por ejemplo, si el servidor se reinició justo después del pago).
 */
export function recoverPaidNotifications(hours = 24): number {
  const rows = db
    .prepare("SELECT id FROM orders WHERE status = 'paid' AND paid_at >= datetime('now', ?)")
    .all(`-${hours} hours`) as unknown as { id: string }[];

  let recovered = 0;
  for (const row of rows) recovered += enqueueOrderPaid(row.id);
  return recovered;
}