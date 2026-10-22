import { db } from "./db.js";
import { getOrder, getStore, type StockShortage } from "./store.js";
import { formatUsdc } from "./money.js";
import { sendText } from "./whatsapp.js";

const CHANNEL = process.env.NOTIFY_CHANNEL ?? "console";
const MERCHANT_WA_ID = process.env.MERCHANT_WA_ID ?? "";

/** Envía un aviso por el canal configurado: WhatsApp o consola. */
async function send(to: string, text: string): Promise<void> {
  if (CHANNEL === "whatsapp") {
    await sendText(to, text);
    return;
  }
  console.log(`\n[notify → ${to}]\n${text}\n`);
}

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

/** Avisa al cliente y a la tienda que un pedido fue pagado. */
export async function notifyOrderPaid(orderId: string, paymentTx: string, explorer: string): Promise<void> {
  const found = getOrder(orderId);
  if (!found) return;

  const { order, items } = found;
  const store = getStore(order.store_id);
  const shortages = parseShortages(order.stock_issue);

  const lines = items.map((i) => `• ${i.quantity} × ${i.name}`).join("\n");
  const total = formatUsdc(order.total_atomic);

  // 1) Cliente
  const customerWarning =
    shortages.length > 0
      ? "\n\n⚠️ Algunos productos se agotaron justo antes de tu pago. La tienda te contactará para ofrecerte un cambio o un reembolso."
      : "";

  await send(
    order.customer_wa_id,
    `✅ *¡Pago recibido!*\n\nPedido *${order.id}*\n${lines}\n*Total:* ${total} USDC\n\nGracias por tu compra en ${store?.name ?? "la tienda"} 🙌${customerWarning}`
  );

  // 2) Tienda
  if (MERCHANT_WA_ID) {
    const merchantWarning =
      shortages.length > 0
        ? `\n\n⚠️ *Atención: pagado sin stock suficiente*\n${shortages
            .map((s) => `• ${s.name}: pidió ${s.requested}, quedaban ${s.available}`)
            .join("\n")}\nContacta al cliente para un cambio o reembolso.`
        : "";

    await send(
      MERCHANT_WA_ID,
      `🛒 *Nuevo pedido pagado* · ${order.id}\n\n${lines}\n*Total:* ${total} USDC\n*Cliente:* ${customerName(order.customer_wa_id)} (+${order.customer_wa_id})\n\nComprobante: ${explorer}/tx/${paymentTx}${merchantWarning}`
    );
  }
}

/** Avisa de un pago adicional sobre un pedido que ya estaba pagado. */
export async function notifyDuplicatePayment(
  orderId: string,
  paymentTx: string,
  amountAtomic: number,
  explorer: string
): Promise<void> {
  const found = getOrder(orderId);
  if (!found) return;

  const { order } = found;
  const amount = formatUsdc(amountAtomic);

  await send(
    order.customer_wa_id,
    `⚠️ Recibimos un pago adicional de ${amount} USDC para tu pedido *${order.id}*, que ya estaba pagado. La tienda te lo reembolsará.`
  );

  if (MERCHANT_WA_ID) {
    await send(
      MERCHANT_WA_ID,
      `⚠️ *Pago duplicado* · ${order.id}\n\nSe recibió otro pago de ${amount} USDC para un pedido ya pagado.\n*Cliente:* ${customerName(order.customer_wa_id)} (+${order.customer_wa_id})\nReembolsa al cliente.\n\nComprobante: ${explorer}/tx/${paymentTx}`
    );
  }
}