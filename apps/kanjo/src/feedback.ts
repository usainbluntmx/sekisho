/**
 * /feedback: cualquier usuario (cliente o comerciante) manda un comentario y le llega al admin.
 * Se guarda en la tabla feedback para revisarlo después. Con tope por persona para que no se abuse.
 */
import { db } from "./db.js";
import { enqueueNotification } from "./outbox.js";

export const FEEDBACK_MAX_CHARS = 1000;
export const FEEDBACK_PER_DAY = 5;

export function recordFeedback(customerId: string, rawText: string): string {
  const text = rawText.trim();
  if (!text) {
    return "Me encantaría saber qué piensas 🙂 Escríbelo en un solo mensaje, así:\n\n/feedback lo que te gustó, lo que no o una idea\n\nLo leemos todo.";
  }
  if (text.length > FEEDBACK_MAX_CHARS) {
    return `Tu comentario es muy largo (${text.length} caracteres). Mándalo en ${FEEDBACK_MAX_CHARS} caracteres o menos, o divídelo en dos.`;
  }
  const today = (db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE customer_id = ? AND created_at > datetime('now', '-1 day')").get(customerId) as { n: number }).n;
  if (Number(today) >= FEEDBACK_PER_DAY) {
    return "Ya recibimos varios comentarios tuyos hoy, ¡gracias! Mañana puedes mandar más.";
  }
  const customer = db.prepare("SELECT name, store_id FROM customers WHERE wa_id = ?").get(customerId) as { name: string; store_id: string | null } | undefined;
  const storeId = customer?.store_id ?? null;
  const result = db.prepare("INSERT INTO feedback (customer_id, store_id, text) VALUES (?, ?, ?)").run(customerId, storeId, text);

  const admin = process.env.KANJO_ADMIN_ID?.trim();
  if (admin && admin !== customerId) {
    const who = customer?.name ? `${customer.name} (${customerId})` : customerId;
    enqueueNotification(`feedback:${result.lastInsertRowid}`, admin, `💬 *Comentario* de ${who}${storeId ? ` · tienda ${storeId}` : ""}\n\n${text}`);
  }
  return "¡Gracias! Ya le llegó tu comentario al equipo de Kanjō 🙌";
}
