import { rmSync } from "node:fs";

// Base de datos temporal, aislada de data/kanjo.db
const TEST_DB = "data/test-payment-safety.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(TEST_DB + suffix, { force: true });
};
cleanup();
process.env.DB_PATH = TEST_DB;

const { db } = await import("../db.js");
const store = await import("../store.js");
const guard = await import("../settlement-guard.js");

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}

// Tienda de prueba con una sola unidad
db.prepare(
  "INSERT INTO stores (id, name, merchant_address) VALUES ('test', 'Tienda de prueba', '0x0000000000000000000000000000000000000001')"
).run();
const { lastInsertRowid } = db
  .prepare("INSERT INTO products (store_id, name, price_atomic, stock) VALUES ('test', 'Último croissant', 20000, 1)")
  .run();
const productId = Number(lastInsertRowid);
store.upsertCustomer("5210000000001", "Cliente A");
store.upsertCustomer("5210000000002", "Cliente B");

console.log("─── Sobreventa (BUG-002) ───");

const a = store.createOrder("test", "5210000000001", [{ productId, quantity: 1 }]).order;
const b = store.createOrder("test", "5210000000002", [{ productId, quantity: 1 }]).order;
check("Dos pedidos pendientes pueden apuntar a la misma última unidad", a.status === "pending_payment" && b.status === "pending_payment");

const paidA = store.markOrderPaid(a.id, "0xAAA");
check("El pedido A se paga sin faltantes", paidA.updated && paidA.shortages.length === 0);

check("El checkout detecta que B ya no tiene stock ANTES de cobrar", store.getStockShortages(b.id).length === 1);

// Carrera: B se liquidó on-chain de todos modos
let threw = false;
let paidB: ReturnType<typeof store.markOrderPaid> | undefined;
try {
  paidB = store.markOrderPaid(b.id, "0xBBB");
} catch {
  threw = true;
}
const orderB = store.getOrder(b.id)?.order;
const { stock } = db.prepare("SELECT stock FROM products WHERE id = ?").get(productId) as { stock: number };

check("Liquidar B sin stock NO lanza excepción", !threw);
check("B queda pagado (el cobro no se pierde)", paidB?.updated === true && orderB?.status === "paid");
check("B queda marcado con el faltante para la tienda", (paidB?.shortages.length ?? 0) === 1 && orderB?.stock_issue !== null);
check("El stock no queda negativo", stock === 0);

console.log("─── Doble pago (BUG-006) ───");

check("Un pedido ya pagado no se vuelve a marcar", store.markOrderPaid(b.id, "0xBBB2").updated === false);

const first = store.recordPayment({ tx: "0xBBB", orderId: b.id, amountAtomic: 20000, kind: "order" });
const again = store.recordPayment({ tx: "0xBBB", orderId: b.id, amountAtomic: 20000, kind: "order" });
const dup = store.recordPayment({ tx: "0xBBB2", orderId: b.id, amountAtomic: 20000, kind: "duplicate" });
const { n } = db.prepare("SELECT COUNT(*) AS n FROM payments WHERE order_id = ?").get(b.id) as { n: number };
check("Registrar la misma tx dos veces deja una sola fila", first && !again);
check("Un pago duplicado queda registrado aparte", dup && n === 2);

check("El candado deja pasar la primera liquidación", guard.tryStartSettlement(a.id));
check("El candado bloquea una segunda liquidación simultánea", !guard.tryStartSettlement(a.id));
guard.endSettlement(a.id);
check("Al liberarse, el candado vuelve a permitir liquidar", guard.tryStartSettlement(a.id));
guard.endSettlement(a.id);

db.close();
cleanup();

console.log(failures === 0 ? "\n✅ Todas las pruebas pasaron" : `\n❌ ${failures} prueba(s) fallaron`);
if (failures > 0) process.exitCode = 1;