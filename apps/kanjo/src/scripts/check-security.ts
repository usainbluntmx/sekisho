import { rmSync } from "node:fs";

// Base de datos temporal y avisos por consola
const TEST_DB = "data/test-security.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(TEST_DB + suffix, { force: true });
};
cleanup();
process.env.DB_PATH = TEST_DB;
process.env.NOTIFY_CHANNEL = "console";

const { Hono } = await import("hono");
const { db } = await import("../db.js");
const store = await import("../store.js");
const { rateLimit, safeEqual } = await import("../security.js");
const outbox = await import("../outbox.js");

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}

console.log("─── Comparación segura ───");
check("Tokens iguales coinciden", safeEqual("abc123", "abc123"));
check("Tokens distintos no coinciden", !safeEqual("abc123", "abc124"));
check("Tokens de distinta longitud no coinciden", !safeEqual("abc", "abcd"));

console.log("─── Rate limit (SEC-001/002) ───");
const app = new Hono();
app.use("/x", rateLimit({ max: 3, windowMs: 60_000 }));
app.get("/x", (c) => c.text("ok"));
const ipA = { headers: { "cf-connecting-ip": "1.1.1.1" } };
const statuses: number[] = [];
for (let i = 0; i < 4; i++) statuses.push((await app.request("/x", ipA)).status);
const blocked = await app.request("/x", ipA);
check("Las 3 primeras peticiones pasan", statuses.slice(0, 3).every((s) => s === 200));
check("La 4.ª petición de la misma IP recibe 429", statuses[3] === 429);
check("El 429 indica cuándo reintentar (Retry-After)", Number(blocked.headers.get("retry-after")) > 0);
check("Otra IP no se ve afectada", (await app.request("/x", { headers: { "cf-connecting-ip": "2.2.2.2" } })).status === 200);

console.log("─── Token del link de pago ───");
db.prepare("INSERT INTO stores (id, name, merchant_address) VALUES ('test', 'Test', '0x0000000000000000000000000000000000000001')").run();
const { lastInsertRowid } = db
  .prepare("INSERT INTO products (store_id, name, price_atomic, stock) VALUES ('test', 'Café', 20000, 10)")
  .run();
store.upsertCustomer("5210000000001", "Cliente");
const o1 = store.createOrder("test", "5210000000001", [{ productId: Number(lastInsertRowid), quantity: 1 }]).order;
const o2 = store.createOrder("test", "5210000000001", [{ productId: Number(lastInsertRowid), quantity: 1 }]).order;
check("Cada pedido tiene un token de 128 bits (22 caracteres base64url)", o1.pay_token?.length === 22);
check("Los tokens son distintos entre pedidos", o1.pay_token !== o2.pay_token);

console.log("─── Bandeja de salida (BUG-005) ───");
const fail: (to: string, body: string) => Promise<void> = async () => {
  throw new Error("simulado");
};
const ok: (to: string, body: string) => Promise<void> = async () => {};

check("Encolar un aviso nuevo", outbox.enqueueNotification("k1", "521", "hola"));
check("El mismo aviso no se duplica", !outbox.enqueueNotification("k1", "521", "hola"));

const r1 = await outbox.processOutbox(fail);
const row1 = db.prepare("SELECT status, attempts FROM outbox WHERE dedupe_key = 'k1'").get() as { status: string; attempts: number };
check("Un envío fallido queda pendiente para reintento", r1.retrying === 1 && row1.status === "pending" && row1.attempts === 1);

const r2 = await outbox.processOutbox(ok);
check("No se reintenta antes de su hora", r2.sent === 0);

db.prepare("UPDATE outbox SET next_attempt_at = datetime('now', '-1 second') WHERE dedupe_key = 'k1'").run();
const r3 = await outbox.processOutbox(ok);
const row3 = db.prepare("SELECT status FROM outbox WHERE dedupe_key = 'k1'").get() as { status: string };
check("Al llegar su hora, el reintento se entrega", r3.sent === 1 && row3.status === "sent");

outbox.enqueueNotification("k2", "521", "hola");
db.prepare("UPDATE outbox SET attempts = ? WHERE dedupe_key = 'k2'").run(outbox.MAX_ATTEMPTS - 1);
const r4 = await outbox.processOutbox(fail);
const row4 = db.prepare("SELECT status FROM outbox WHERE dedupe_key = 'k2'").get() as { status: string };
check("Tras el último intento queda como fallido", r4.failed === 1 && row4.status === "failed");

db.close();
cleanup();

console.log(failures === 0 ? "\n✅ Todas las pruebas pasaron" : `\n❌ ${failures} prueba(s) fallaron`);
if (failures > 0) process.exitCode = 1;