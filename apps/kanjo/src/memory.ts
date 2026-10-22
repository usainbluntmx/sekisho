import { db } from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id      TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_wa_id ON conversation_messages (wa_id, id);
`);

/** Ventana de memoria de la conversación: un cliente que vuelve mañana empieza limpio. */
const HISTORY_HOURS = Number(process.env.HISTORY_HOURS ?? 12);

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** Últimos mensajes recientes del cliente, en orden cronológico y empezando por 'user'. */
export function getHistory(waId: string, limit = 20): HistoryMessage[] {
  const rows = db
    .prepare(
      `SELECT role, content FROM conversation_messages
       WHERE wa_id = ? AND created_at >= datetime('now', ?)
       ORDER BY id DESC LIMIT ?`
    )
    .all(waId, `-${HISTORY_HOURS} hours`, limit) as unknown as HistoryMessage[];

  const history = rows.reverse();
  while (history.length > 0 && history[0].role !== "user") history.shift();
  return history;
}

/** Guarda el intercambio completo (pregunta y respuesta) para mantener la alternancia. */
export function saveExchange(waId: string, userText: string, assistantText: string): void {
  const insert = db.prepare(
    "INSERT INTO conversation_messages (wa_id, role, content) VALUES (?, ?, ?)"
  );
  insert.run(waId, "user", userText);
  insert.run(waId, "assistant", assistantText);
}

export function clearHistory(waId: string): void {
  db.prepare("DELETE FROM conversation_messages WHERE wa_id = ?").run(waId);
}