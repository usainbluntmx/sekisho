/** Retención de datos, /olvidarme, índices, tienda por defecto oculta y reparto tras un pago. */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { createSekishoDistributor, type SekishoClient } from "@zero-two-labs/sekisho";

const TEST_DB = join(tmpdir(), `kanjo-retention-${process.pid}.db`);
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(TEST_DB + suffix, { force: true });
};
cleanup();
process.env.DB_PATH = TEST_DB;
process.env.STORE_ID = "cafe-kanjo";

const { db } = await import("../db.js");
const store = await import("../store.js");
const { applyRetention, forgetCustomer } = await import("../retention.js");
const { saveExchange, getHistory } = await import("../memory.js");
await import("../outbox.js");
await import("../catalog-import.js");
const wl = await import("../wallet-link.js");

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "✔" : "✘"} ${name}`);
  if (!ok) failures++;
}

const WALLET = "0xa0B6Ce98E5744E0B7523F9e2DA67d73b24727485";
store.createStore({ id: "cafe-kanjo", name: "Café Kanjō", merchant: WALLET });
const productId = Number(db.prepare("INSERT INTO products (store_id, name, price_atomic, stock) VALUES ('cafe-kanjo', 'Café', 1000000, 100)").run().lastInsertRowid);
store.upsertCustomer("5215550001", "Ana");
const order = () => store.createOrder("cafe-kanjo", "5215550001", [{ productId, quantity: 1 }]).order;

console.log("─── Índices (PERF-002) ───");
const indexes = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name));
check(
  "Existen los índices de pedidos, partidas, pagos, productos, tiendas, catálogos y repartos",
  ["idx_orders_status_expires", "idx_orders_customer", "idx_orders_store_status", "idx_order_items_order", "idx_payments_order", "idx_products_store_active", "idx_stores_owner", "idx_stores_status", "idx_catalog_imports_store"].every((n) => indexes.has(n))
);
const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT id FROM orders WHERE status = 'pending_payment' AND expires_at <= datetime('now')").all() as { detail: string }[]).map((r) => r.detail).join(" ");
check("El barrido de pedidos vencidos usa su índice (no recorre la tabla)", /idx_orders_status_expires/.test(plan));

console.log("─── Retención (ARCH-011) ───");
saveExchange("5215550001", "viejo", "respuesta vieja");
db.prepare("UPDATE conversation_messages SET created_at = datetime('now', '-40 days')").run();
saveExchange("5215550001", "nuevo", "respuesta nueva");

const oldCancelled = order();
db.prepare("UPDATE orders SET status = 'cancelled', cancel_reason = 'expired', created_at = datetime('now', '-120 days') WHERE id = ?").run(oldCancelled.id);
const oldCancelledPaid = order(); // cancelado pero con un pago registrado: es registro, no se toca
db.prepare("UPDATE orders SET status = 'cancelled', created_at = datetime('now', '-120 days') WHERE id = ?").run(oldCancelledPaid.id);
db.prepare("INSERT INTO payments (tx, order_id, amount_atomic, kind) VALUES ('0xpago', ?, 1000000, 'order')").run(oldCancelledPaid.id);
const recentCancelled = order();
db.prepare("UPDATE orders SET status = 'cancelled', created_at = datetime('now', '-10 days') WHERE id = ?").run(recentCancelled.id);
const oldPaid = order();
store.markOrderPaid(oldPaid.id, "0xpagado");
db.prepare("UPDATE orders SET created_at = datetime('now', '-400 days') WHERE id = ?").run(oldPaid.id);

db.prepare("INSERT INTO outbox (dedupe_key, recipient, body, status, created_at) VALUES ('viejo', 'x', 'y', 'sent', datetime('now', '-40 days'))").run();
db.prepare("INSERT INTO outbox (dedupe_key, recipient, body, status, created_at) VALUES ('pendiente', 'x', 'y', 'pending', datetime('now', '-40 days'))").run();
db.prepare("INSERT INTO catalog_imports (id, store_id, source_url, status, currency, payload, created_at) VALUES ('prev-vieja', 'cafe-kanjo', 'chat', 'applied', 'MXN', '{}', datetime('now', '-10 days'))").run();
db.prepare("INSERT INTO catalog_imports (id, store_id, source_url, status, currency, payload) VALUES ('prev-nueva', 'cafe-kanjo', 'chat', 'preview', 'MXN', '{}')").run();
const usedLink = wl.createWalletLink("tg-1", "Tienda");
db.prepare("UPDATE wallet_links SET status = 'applied', created_at = datetime('now', '-40 days') WHERE token = ?").run(usedLink.token);
const openLink = wl.createWalletLink("tg-2", "Tienda");

const r = applyRetention();
check("Conversaciones de más de 30 días → borradas; las recientes se quedan", r.conversations === 2 && getHistory("5215550001").length === 2);
check("Pedido cancelado de hace 120 días sin pago → borrado (con sus partidas)", !store.getOrder(oldCancelled.id) && !db.prepare("SELECT 1 FROM order_items WHERE order_id = ?").get(oldCancelled.id));
check("Pedido cancelado con un pago registrado → se conserva", Boolean(store.getOrder(oldCancelledPaid.id)));
check("Pedido cancelado reciente → se conserva", Boolean(store.getOrder(recentCancelled.id)));
check("Pedido pagado (aunque tenga más de un año) → se conserva siempre", Boolean(store.getOrder(oldPaid.id)));
check("Avisos enviados de más de 30 días → borrados; los pendientes no", r.notices === 1 && Boolean(db.prepare("SELECT 1 FROM outbox WHERE dedupe_key = 'pendiente'").get()));
check("Vistas previas de catálogo de más de 7 días → borradas; las recientes no", r.catalogPreviews === 1 && Boolean(db.prepare("SELECT 1 FROM catalog_imports WHERE id = 'prev-nueva'").get()));
check("Links de wallet usados de más de 30 días → borrados; los abiertos no", r.walletLinks === 1 && Boolean(wl.getWalletLink(openLink.token)));
const again = applyRetention();
check("Correr la limpieza otra vez no borra nada más", Object.values(again).every((n) => n === 0));

console.log("─── /olvidarme ───");
const { handleMessage } = await import("../bot.js");
const said: string[] = [];
const send = async (_to: string, text: string) => {
  said.push(text);
};
await handleMessage({ from: "5215550001", name: "Ana", type: "text", text: "/olvidarme" }, send);
check("/olvidarme explica qué se borra y qué se conserva, y pide confirmar", /conversación y tu nombre[\s\S]*pedidos se conservan[\s\S]*\/olvidarme confirmo/.test(said.at(-1) ?? "") && getHistory("5215550001").length === 2);
await handleMessage({ from: "5215550001", name: "Ana", type: "text", text: "/olvidarme confirmo" }, send);
const customer = db.prepare("SELECT name FROM customers WHERE wa_id = '5215550001'").get() as { name: string };
check("/olvidarme confirmo → borra la conversación y el nombre", getHistory("5215550001").length === 0 && customer.name === "" && /borré/.test(said.at(-1) ?? ""));
check("…y sus pedidos pagados se conservan", Boolean(store.getOrder(oldPaid.id)));
check("forgetCustomer de alguien sin datos no falla", forgetCustomer("no-existe").conversations === 0);

console.log("─── Tienda por defecto oculta (mainnet) ───");
store.setStoreStatus("cafe-kanjo", "draft");
check("Si la demo está oculta, un cliente nuevo no queda con ella", store.getCustomerStore("5215559999") === undefined);
await handleMessage({ from: "5215559999", name: "Nuevo", type: "text", text: "hola" }, send);
check("…y el bot le pide abrir el link de una tienda (y ofrece /vender)", /abre el link de la tienda[\s\S]*\/vender/.test(said.at(-1) ?? ""));
store.setStoreStatus("cafe-kanjo", "published");
check("Con la demo publicada, sigue siendo la tienda por defecto", store.getCustomerStore("5215559999")?.id === "cafe-kanjo");

console.log("─── Reparto tras un pago: solo el vault que cobró (PERF-003) ───");
{
  // Mismo patrón que distributor.ts: el SDK lee la lista de vendedores al empezar la revisión
  const A = getAddress("0x1111111111111111111111111111111111111111") as Address;
  const B = getAddress("0x2222222222222222222222222222222222222222") as Address;
  const asked: Address[] = [];
  const fake = {
    config: { explorer: "https://x" },
    getConfig: async () => ({ feeBps: 150, feeChange: null }),
    pending: async (m: Address) => {
      asked.push(m);
      return { total: 0n, fee: 0n, merchant: 0n };
    },
    distribute: async () => "0x",
  } as unknown as SekishoClient;
  let only: Address | null = null;
  const d = createSekishoDistributor({ sekisho: fake, merchants: () => (only ? [only] : [A, B]), log: () => {} });
  only = A;
  const run = d.check();
  only = null;
  await run;
  check("Tras un pago se revisa solo ese vault", asked.join() === A);
  asked.length = 0;
  await d.check();
  check("La revisión periódica sigue revisando todos", asked.join() === [A, B].join());
}

db.close();
cleanup();
console.log(failures === 0 ? "\n✅ Todas las pruebas pasaron" : `\n❌ ${failures} prueba(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
