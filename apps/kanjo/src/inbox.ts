import { db } from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_messages (
    id          TEXT PRIMARY KEY,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/**
 * Registra un mensaje entrante. Devuelve true si es nuevo y false si ya se
 * había recibido (por ejemplo, un reintento de Meta con el mismo id).
 */
export function claimMessage(messageId: string): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO processed_messages (id) VALUES (?)")
    .run(messageId);
  return Number(result.changes) > 0;
}

/** Borra ids antiguos: Meta reintenta durante horas, no semanas. */
export function pruneProcessedMessages(days = 7): void {
  db.prepare("DELETE FROM processed_messages WHERE received_at < datetime('now', ?)").run(
    `-${days} days`
  );
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