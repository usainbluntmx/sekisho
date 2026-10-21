import { db } from "./db.js";
import { getOrder, getStore } from "./store.js";
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

/** Avisa al cliente y a la tienda que un pedido fue pagado. */
export async function notifyOrderPaid(orderId: string, paymentTx: string, explorer: string): Promise<void> {
  const found = getOrder(orderId);
  if (!found) return;

  const { order, items } = found;
  const store = getStore(order.store_id);
  const customer = db
    .prepare("SELECT name FROM customers WHERE wa_id = ?")
    .get(order.customer_wa_id) as { name: string } | undefined;

  const lines = items.map((i) => `• ${i.quantity} × ${i.name}`).join("\n");
  const total = formatUsdc(order.total_atomic);

  // 1) Cliente
  await send(
    order.customer_wa_id,
    `✅ *¡Pago recibido!*\n\nPedido *${order.id}*\n${lines}\n*Total:* ${total} USDC\n\nGracias por tu compra en ${store?.name ?? "la tienda"} 🙌`
  );

  // 2) Tienda
  if (MERCHANT_WA_ID) {
    await send(
      MERCHANT_WA_ID,
      `🛒 *Nuevo pedido pagado* · ${order.id}\n\n${lines}\n*Total:* ${total} USDC\n*Cliente:* ${customer?.name || "Sin nombre"} (+${order.customer_wa_id})\n\nComprobante: ${explorer}/tx/${paymentTx}`
    );
  }
}