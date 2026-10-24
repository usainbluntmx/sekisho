import { rmSync } from "node:fs";

// Base de datos temporal
const TEST_DB = "data/test-inbox.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(TEST_DB + suffix, { force: true });
};
cleanup();
process.env.DB_PATH = TEST_DB;

const { db } = await import("../db.js");

// Simula una base de datos anterior: tabla processed_messages con un id ya atendido
db.exec(`
  CREATE TABLE processed_messages (id TEXT PRIMARY KEY, received_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO processed_messages (id) VALUES ('wamid.legacy');
`);

const inbox = await import("../inbox.js");

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}
const msg = (id: string, text = "hola") => ({ id, from: "5215500000000", name: "Test", type: "text", text });
const status = (id: string) =>
  (db.prepare("SELECT status FROM inbox_messages WHERE id = ?").get(id) as { status: string } | undefined)?.status;
const pendingIds = () => inbox.recoverPendingMessages().map((m) => m.id);

console.log("─── Migración ───");
const legacyTable = db.prepare("SELECT name FROM sqlite_master WHERE name = 'processed_messages'").get();
check("La tabla anterior se eliminó", legacyTable === undefined);
check("Un id ya atendido antes de la migración sigue contando como duplicado", !inbox.saveIncoming(msg("wamid.legacy")));

console.log("─── Guardado y duplicados (BUG-003) ───");
check("Un mensaje nuevo se guarda", inbox.saveIncoming(msg("wamid.A", "quiero un café")));
check("El mismo id otra vez es duplicado", !inbox.saveIncoming(msg("wamid.A", "quiero un café")));
check("El mensaje queda pendiente hasta procesarse", status("wamid.A") === "pending");

console.log("─── Recuperación tras caída ───");
inbox.markStarted("wamid.A"); // el proceso empezó a procesarlo… y murió
const recovered = inbox.recoverPendingMessages();
check("Al arrancar se recupera el mensaje pendiente", recovered.length === 1 && recovered[0].id === "wamid.A");
check("Se recupera con su remitente y texto", recovered[0].from === "5215500000000" && recovered[0].text === "quiero un café");
inbox.markDone("wamid.A");
check("Procesado, queda como done", status("wamid.A") === "done");
check("Un mensaje procesado no se vuelve a recuperar", !pendingIds().includes("wamid.A"));

inbox.saveIncoming(msg("wamid.B"));
inbox.markStarted("wamid.B");
inbox.markFailed("wamid.B", new Error("Claude API caída"));
check("Un error deja el mensaje como failed", status("wamid.B") === "failed");
check("Un mensaje fallido no se recupera en bucle", !pendingIds().includes("wamid.B"));

console.log("─── Límites ───");
inbox.saveIncoming(msg("wamid.C"));
for (let i = 0; i < 3; i++) inbox.markStarted("wamid.C"); // tumbó el proceso 3 veces
check("Tras 3 intentos no se recupera", !pendingIds().includes("wamid.C"));
check("…y queda como failed", status("wamid.C") === "failed");

inbox.saveIncoming(msg("wamid.D"));
db.prepare("UPDATE inbox_messages SET received_at = datetime('now', '-2 hours') WHERE id = 'wamid.D'").run();
check("Un pendiente de hace 2 h no se responde tarde", !pendingIds().includes("wamid.D"));
check("…y queda como expired", status("wamid.D") === "expired");

console.log("─── Limpieza ───");
inbox.saveIncoming(msg("wamid.E"));
db.prepare("UPDATE inbox_messages SET received_at = datetime('now', '-10 days')").run();
db.prepare("UPDATE inbox_messages SET status = 'pending' WHERE id = 'wamid.E'").run();
inbox.pruneInbox();
const left = db.prepare("SELECT id FROM inbox_messages").all() as { id: string }[];
check("Se borran los resueltos de más de 7 días y se conservan los pendientes", left.length === 1 && left[0].id === "wamid.E");

db.close();
cleanup();
if (failures > 0) {
  console.error(`\n❌ ${failures} prueba(s) fallaron`);
  process.exit(1);
}
console.log("\n✅ Todas las pruebas pasaron");