import { db } from "./db.js";
import { sendText } from "./whatsapp.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key      TEXT NOT NULL UNIQUE,
    recipient       TEXT NOT NULL,
    body            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (status, next_attempt_at);
`);

/** Espera antes de cada reintento: 30 s, 2 min, 10 min, 30 min, 2 h. */
const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

const CHANNEL = process.env.NOTIFY_CHANNEL ?? "console";

export type Deliver = (to: string, body: string) => Promise<void>;

/** Entrega por el canal configurado. Lanza error si falla, para reintentar. */
export const defaultDeliver: Deliver = async (to, body) => {
  if (CHANNEL === "whatsapp") {
    await sendText(to, body);
    return;
  }
  console.log(`\n[notify → ${to}]\n${body}\n`);
};

/** Agrega un aviso a la bandeja. Idempotente por dedupe_key: devuelve true si es nuevo. */
export function enqueueNotification(dedupeKey: string, recipient: string, body: string): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO outbox (dedupe_key, recipient, body) VALUES (?, ?, ?)")
    .run(dedupeKey, recipient, body);
  return Number(result.changes) > 0;
}

interface OutboxRow {
  id: number;
  dedupe_key: string;
  recipient: string;
  body: string;
  attempts: number;
}

let processing = false;

/** Entrega los avisos pendientes cuya hora de (re)intento ya llegó. */
export async function processOutbox(
  deliver: Deliver = defaultDeliver
): Promise<{ sent: number; failed: number; retrying: number }> {
  const stats = { sent: 0, failed: 0, retrying: 0 };
  if (processing) return stats;
  processing = true;

  try {
    const rows = db
      .prepare(
        `SELECT id, dedupe_key, recipient, body, attempts FROM outbox
         WHERE status = 'pending' AND next_attempt_at <= datetime('now')
         ORDER BY id LIMIT 50`
      )
      .all() as unknown as OutboxRow[];

    for (const row of rows) {
      const attempts = row.attempts + 1;
      try {
        await deliver(row.recipient, row.body);
        db.prepare(
          "UPDATE outbox SET status = 'sent', attempts = ?, sent_at = datetime('now'), last_error = NULL WHERE id = ?"
        ).run(attempts, row.id);
        stats.sent++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (attempts >= MAX_ATTEMPTS) {
          db.prepare("UPDATE outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(
            attempts,
            message,
            row.id
          );
          console.error(`[outbox] ${row.dedupe_key} falló definitivamente tras ${attempts} intentos: ${message}`);
          stats.failed++;
        } else {
          const delay = BACKOFF_SECONDS[attempts - 1];
          db.prepare(
            "UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = datetime('now', ?) WHERE id = ?"
          ).run(attempts, message, `+${delay} seconds`, row.id);
          console.warn(`[outbox] ${row.dedupe_key} falló (intento ${attempts}), reintento en ${delay} s: ${message}`);
          stats.retrying++;
        }
      }
    }

    return stats;
  } finally {
    processing = false;
  }
}

/** Revisión periódica de la bandeja. */
export function startOutboxWorker(intervalSeconds = 30): void {
  const tick = () => {
    void processOutbox().catch((error) => console.error("[outbox] Error inesperado:", error));
  };
  setInterval(tick, intervalSeconds * 1000).unref();
  tick();
}