/**
 * Retención de datos (SEKISHO-ARCH-011): lo que ya no sirve se borra solo, una vez al día.
 *
 * Se conserva lo que la tienda necesita como registro (pedidos pagados, pagos y repartos).
 * Se borra lo que solo sirvió un rato:
 *   - conversaciones de más de CONVERSATION_RETENTION_DAYS (30): el agente solo lee las últimas horas;
 *   - vistas previas de catálogo de más de 7 días (aplicadas o no);
 *   - pedidos cancelados (nunca pagados) de más de ORDER_RETENTION_DAYS (90);
 *   - avisos ya enviados o fallidos de más de 30 días;
 *   - links de firma de wallet ya usados o vencidos de más de 30 días.
 *
 * Además, `/olvidarme` borra a pedido del cliente su conversación y su nombre.
 */
import { db } from "./db.js";
// Tablas que este módulo limpia: se importan para que existan aunque nadie más las haya cargado
import "./memory.js";
import "./inbox.js";
import "./outbox.js";
import "./catalog-import.js";
import "./wallet-link.js";

export interface RetentionResult {
  conversations: number;
  catalogPreviews: number;
  cancelledOrders: number;
  notices: number;
  walletLinks: number;
}

const days = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
};
const ago = (n: number) => `-${n} days`;
const changes = (result: { changes: number | bigint }) => Number(result.changes);

export function applyRetention(): RetentionResult {
  const conversationDays = days("CONVERSATION_RETENTION_DAYS", 30);
  const orderDays = days("ORDER_RETENTION_DAYS", 90);

  const result: RetentionResult = { conversations: 0, catalogPreviews: 0, cancelledOrders: 0, notices: 0, walletLinks: 0 };
  db.exec("BEGIN");
  try {
    result.conversations = changes(db.prepare("DELETE FROM conversation_messages WHERE created_at < datetime('now', ?)").run(ago(conversationDays)));
    result.catalogPreviews = changes(db.prepare("DELETE FROM catalog_imports WHERE created_at < datetime('now', ?)").run(ago(7)));

    // Solo pedidos cancelados que nunca recibieron un pago (ni tx ni filas en payments)
    const stale = `SELECT id FROM orders
      WHERE status = 'cancelled' AND payment_tx IS NULL AND created_at < datetime('now', ?)
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id)`;
    db.prepare(`DELETE FROM order_items WHERE order_id IN (${stale})`).run(ago(orderDays));
    result.cancelledOrders = changes(db.prepare(`DELETE FROM orders WHERE id IN (${stale})`).run(ago(orderDays)));

    result.notices = changes(db.prepare("DELETE FROM outbox WHERE status IN ('sent', 'failed') AND created_at < datetime('now', ?)").run(ago(30)));
    result.walletLinks = changes(
      db.prepare("DELETE FROM wallet_links WHERE (status != 'open' OR expires_at < datetime('now')) AND created_at < datetime('now', ?)").run(ago(30))
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return result;
}

/**
 * Borrado a pedido del cliente: su conversación, los mensajes recibidos guardados y su nombre.
 * Sus pedidos se conservan (son el registro de venta de la tienda), sin nombre.
 */
export function forgetCustomer(customerId: string): { conversations: number } {
  db.exec("BEGIN");
  try {
    const conversations = changes(db.prepare("DELETE FROM conversation_messages WHERE wa_id = ?").run(customerId));
    db.prepare("DELETE FROM inbox_messages WHERE wa_from = ? AND status != 'pending'").run(customerId);
    db.prepare("UPDATE inbox_messages SET name = '' WHERE wa_from = ?").run(customerId);
    db.prepare("UPDATE customers SET name = '' WHERE wa_id = ?").run(customerId);
    db.exec("COMMIT");
    return { conversations };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
