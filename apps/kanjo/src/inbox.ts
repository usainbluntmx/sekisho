import { db } from "./db.js";
import type { IncomingMessage } from "./whatsapp.js";

/** Intentos máximos por mensaje (protege contra un mensaje que siempre falla). */
const MAX_ATTEMPTS = 3;

db.exec(`
  CREATE TABLE IF NOT EXISTS inbox_messages (
    id           TEXT PRIMARY KEY,                 -- id de WhatsApp (wamid…)
    wa_from      TEXT NOT NULL,
    name         TEXT NOT NULL DEFAULT '',
    type         TEXT NOT NULL,
    text         TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed | expired
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    received_at  TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_messages (status, received_at);
`);

// Migración: los ids del registro anterior (processed_messages) siguen sirviendo para descartar duplicados
const legacy = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'processed_messages'")
  .get();
if (legacy) {
  db.exec(`
    INSERT OR IGNORE INTO inbox_messages (id, wa_from, type, status, received_at, processed_at)
      SELECT id, '', 'legacy', 'done', received_at, received_at FROM processed_messages;
    DROP TABLE processed_messages;
  `);
}

/**
 * Guarda el mensaje en disco ANTES de responder 200 a Meta.
 * Devuelve true si es nuevo y false si es un duplicado (reintento de Meta con el mismo id).
 */
export function saveIncoming(msg: IncomingMessage): boolean {
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO inbox_messages (id, wa_from, name, type, text) VALUES (?, ?, ?, ?, ?)"
    )
    .run(msg.id, msg.from, msg.name, msg.type, msg.text ?? null);
  return Number(result.changes) > 0;
}

/** Cuenta un intento de procesamiento (antes de llamar al agente). */
export function markStarted(id: string): void {
  db.prepare("UPDATE inbox_messages SET attempts = attempts + 1 WHERE id = ?").run(id);
}

export function markDone(id: string): void {
  db.prepare(
    "UPDATE inbox_messages SET status = 'done', processed_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function markFailed(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(
    "UPDATE inbox_messages SET status = 'failed', last_error = ?, processed_at = datetime('now') WHERE id = ?"
  ).run(message.slice(0, 500), id);
}

/**
 * Al arrancar: devuelve los mensajes que quedaron pendientes (el proceso murió antes de terminarlos).
 * Los muy viejos se marcan como expirados (responder horas después confunde al cliente) y los que
 * ya agotaron sus intentos, como fallidos.
 */
export function recoverPendingMessages(maxAgeMinutes = 30): IncomingMessage[] {
  db.prepare(
    "UPDATE inbox_messages SET status = 'expired', processed_at = datetime('now') WHERE status = 'pending' AND received_at < datetime('now', ?)"
  ).run(`-${maxAgeMinutes} minutes`);
  db.prepare(
    "UPDATE inbox_messages SET status = 'failed', last_error = 'max attempts', processed_at = datetime('now') WHERE status = 'pending' AND attempts >= ?"
  ).run(MAX_ATTEMPTS);

  const rows = db
    .prepare(
      "SELECT id, wa_from, name, type, text FROM inbox_messages WHERE status = 'pending' ORDER BY received_at, rowid"
    )
    .all() as { id: string; wa_from: string; name: string; type: string; text: string | null }[];

  return rows.map((r) => ({ id: r.id, from: r.wa_from, name: r.name, type: r.type, text: r.text ?? undefined }));
}

/** Borra mensajes ya resueltos: Meta reintenta durante horas, no semanas. */
export function pruneInbox(days = 7): void {
  db.prepare(
    "DELETE FROM inbox_messages WHERE status != 'pending' AND received_at < datetime('now', ?)"
  ).run(`-${days} days`);
}

/** Cola por clave: tareas de la misma clave en orden; claves distintas en paralelo. */
const queues = new Map<string, Promise<void>>();

export function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task);

  // La cola guarda una versión que nunca falla, para que un error no la bloquee
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });

  return run;
}