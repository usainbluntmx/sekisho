import { rmSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";

// Base de datos temporal, aislada de data/kanjo.db (nada toca la cadena)
const TEST_DB = "data/test-orders.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(TEST_DB + suffix, { force: true });
};
cleanup();
process.env.DB_PATH = TEST_DB;
process.env.ORDER_TTL_MINUTES = "30";
process.env.OPERATOR_PRIVATE_KEY ??= generatePrivateKey();

const { db } = await import("../db.js");
const store = await import("../store.js");
const units = await import("../units.js");
const { blockReason, EXPIRED_MESSAGE } = await import("../order-payment.js");
const { executeTool } = await import("../tools.js");
const { normalizeItems, normalizeUnit } = await import("../catalog-normalize.js");
const { renderCheckoutPage } = await import("../web/checkout-page.js");

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}
const throws = (fn: () => unknown, re: RegExp) => {
  try {
    fn();
    return false;
  } catch (error) {
    return re.test((error as Error).message);
  }
};

// Carnicería de prueba: arrachera por kg (8.11 USDC/kg, 2 kg en existencia) y tortillas por pieza
db.prepare("INSERT INTO stores (id, name, merchant_address) VALUES ('don-pepe', 'Carnicería Don Pepe', '0x0000000000000000000000000000000000000001')").run();
const add = (name: string, price: number, stock: number, unit: "pieza" | "kg") =>
  Number(
    db.prepare("INSERT INTO products (store_id, name, price_atomic, stock, unit) VALUES ('don-pepe', ?, ?, ?, ?)").run(name, price, stock, unit)
      .lastInsertRowid
  );
for (const id of ["5215550001", "5215550002", "5215550003"]) store.upsertCustomer(id, "Cliente");
const arrachera = add("Arrachera", 8_110_000, 2_000, "kg");
const tortillas = add("Paquete de tortillas", 1_000_000, 10, "pieza");

console.log("─── Cantidades ───");
check("Medio kilo → 500 g", units.toBase(0.5, "kg") === 500);
check("0.333 kg → 333 g (3 decimales)", units.toBase(0.333, "kg") === 333);
check("0.3333 kg → error (más de 3 decimales)", throws(() => units.toBase(0.3333, "kg"), /3 decimales/));
check("30 g → error (mínimo 50 g)", throws(() => units.toBase(0.03, "kg"), /mínimo es 50 g/));
check("150 kg → error (máximo 100 kg)", throws(() => units.toBase(150, "kg"), /máximo es 100 kg/));
check("1.5 piezas → error (enteros)", throws(() => units.toBase(1.5, "pieza"), /enteros/));
check("Se muestra 250 g, 1.5 kg y 3", units.formatQuantity(250, "kg") === "250 g" && units.formatQuantity(1500, "kg") === "1.5 kg" && units.formatQuantity(3, "pieza") === "3");
check("Precio por kilo se muestra con '/ kg'", units.priceLabel(8_110_000, "kg") === "8.11 USDC / kg");

console.log("─── Importe por peso ───");
check("750 g × 8.11/kg = 6.0825 → 6.08 (al centavo)", units.lineTotalAtomic(8_110_000, 750, "kg") === 6_080_000);
check("1 kg × 8.11/kg = 8.11 exacto", units.lineTotalAtomic(8_110_000, 1000, "kg") === 8_110_000);
check("Una línea nunca baja de 0.01", units.lineTotalAtomic(10_000, 50, "kg") === 10_000);

console.log("─── Pedido por peso ───");
const created = store.createOrder("don-pepe", "5215550001", [
  { productId: arrachera, quantity: 0.75 },
  { productId: tortillas, quantity: 2 },
]);
check("El total suma las líneas: 6.08 + 2 × 1.00 = 8.08", created.order.total_atomic === 8_080_000);
check("La arrachera se guarda en gramos (750) con su unidad", created.items[0].quantity === 750 && created.items[0].unit === "kg");
check("Las tortillas siguen por pieza", created.items[1].quantity === 2 && created.items[1].unit === "pieza");
check(
  "Pedir más peso del que hay → error claro",
  throws(() => store.createOrder("don-pepe", "5215550001", [{ productId: arrachera, quantity: 2.5 }]), /stock de Arrachera/)
);
check(
  "Kilos en un producto por pieza → error con su nombre",
  throws(() => store.createOrder("don-pepe", "5215550001", [{ productId: tortillas, quantity: 0.5 }]), /Paquete de tortillas: .*enteros/)
);
check("Al pagar, el stock baja en gramos (2000 → 1250)", store.markOrderPaid(created.order.id, "0xaa").updated && store.getProduct("don-pepe", arrachera)?.stock === 1_250);

console.log("─── Lo que ve el agente ───");
const catalog = JSON.parse(executeTool("catalog_list", {}, { storeId: "don-pepe", customerWaId: "5215550002" }).content);
const meat = catalog.find((p: any) => p.product_id === arrachera);
check("catalog_list: unidad kg, precio por kg y stock en kg (1.25)", meat.unit === "kg" && meat.price_per === "kg" && meat.stock === 1.25);
const placed = JSON.parse(
  executeTool("order_create", { items: [{ product_id: arrachera, quantity: 0.25 }] }, { storeId: "don-pepe", customerWaId: "5215550002" }).content
);
check("order_create: 250 g, importe de la línea y vencimiento", placed.items[0].weight === "250 g" && placed.items[0].line_total_usdc === "2.03" && placed.expires_in_minutes === 30);
check("El pedido vence en 30 min (ORDER_TTL_MINUTES)", Math.abs((store.expiresAtMs(store.getOrder(placed.order_id)!.order) ?? 0) - (Date.now() + 30 * 60_000)) < 5_000);

console.log("─── Caducidad ───");
const fresh = store.getOrder(placed.order_id)!.order;
check("Un pedido nuevo no ha vencido", !store.isExpired(fresh) && blockReason(fresh.id, fresh.pay_token!) === null);
db.prepare("UPDATE orders SET expires_at = datetime('now', '-1 minutes') WHERE id = ?").run(fresh.id);
check("Con la hora pasada, el link ya no cobra (aunque el barrido no haya corrido)", blockReason(fresh.id, fresh.pay_token!)?.error === EXPIRED_MESSAGE);
check("Un pago en curso se respeta: el barrido no lo vence", store.expireOrders((id) => id === fresh.id).length === 0 && store.getOrder(fresh.id)!.order.status === "pending_payment");
check("El barrido lo vence", store.expireOrders().join() === fresh.id);
const expired = store.getOrder(fresh.id)!.order;
check("…queda cancelado por vencimiento", expired.status === "cancelled" && expired.cancel_reason === "expired" && store.isExpired(expired));
const status = JSON.parse(executeTool("order_status", { order_id: fresh.id }, { storeId: "don-pepe", customerWaId: "5215550002" }).content);
check("order_status dice 'expired' y no da link de pago", status.status === "expired" && status.payment_url === undefined);
check("El checkout muestra que venció (sin botón de pago)", /venció sin pagarse/.test(renderCheckoutPage({ store: store.getStore("don-pepe")!, order: expired, items: store.getOrder(fresh.id)!.items, usdc: "0x0", chainId: 43113, explorer: "x", payToken: "t" })) );
check("Barrer otra vez no cambia nada", store.expireOrders().length === 0);
check("Si el pago ya se liquidó on-chain, el pedido vencido se paga igual (no se pierde el cobro)", store.markOrderPaid(fresh.id, "0xbb").updated && store.getOrder(fresh.id)!.order.status === "paid");

const old = store.createOrder("don-pepe", "5215550003", [{ productId: tortillas, quantity: 1 }]);
db.prepare("UPDATE orders SET expires_at = NULL, created_at = datetime('now', '-31 minutes') WHERE id = ?").run(old.order.id);
check("Pedidos de antes (sin expires_at) vencen por su fecha de creación", store.expireOrders().join() === old.order.id);
const paid = store.getOrder(created.order.id)!.order;
check("Un pedido pagado nunca vence", paid.status === "paid" && !store.isExpired(paid));

console.log("─── Catálogo por kilo ───");
check("'por kilo', 'KG' y 'kilo' → kg; otra cosa → pieza", normalizeUnit("por kilo") === "kg" && normalizeUnit("KG") === "kg" && normalizeUnit("kilo") === "kg" && normalizeUnit("paquete") === "pieza" && normalizeUnit(undefined) === "pieza");
const extracted = normalizeItems([{ name: "Bistec", price: 150, unit: "kg" }], { currency: "USD", sourceUrl: "https://x", maxItems: 10 });
check("Un producto importado con unit kg queda por kilo", extracted.items[0]?.unit === "kg" && extracted.items[0].price_atomic === 150_000_000);

console.log("─── Página de pago por HTTP (el link que recibe el cliente) ───");
{
  const { Hono } = await import("hono");
  const { registerCheckoutPage } = await import("../checkout.js");
  const { paymentUrl } = await import("../tools.js");
  const app = new Hono();
  registerCheckoutPage(app);

  const live = store.createOrder("don-pepe", "5215550001", [{ productId: tortillas, quantity: 1 }]).order;
  const url = new URL(paymentUrl(live)!);
  const path = url.pathname + url.search;
  const ok = await app.request(path);
  const okBody = await ok.text();
  check(
    "El link de pago responde 200 con la página (text/html)",
    ok.status === 200 && (ok.headers.get("content-type") ?? "").includes("text/html") && okBody.includes(live.id)
  );
  check("La página usa la tienda del pedido", okBody.includes("Carnicería Don Pepe"));

  const lower = await app.request(`/pay/${live.id.toLowerCase()}?t=${live.pay_token}`);
  check("El id en minúsculas también abre el pedido", lower.status === 200);

  const badToken = await app.request(`/pay/${live.id}?t=token-falso`);
  check(
    "Token inválido → 404 con la página HTML (no el 404 genérico)",
    badToken.status === 404 && (badToken.headers.get("content-type") ?? "").includes("text/html")
  );
  const noToken = await app.request(`/pay/${live.id}`);
  check("Sin token → 404 HTML", noToken.status === 404 && (noToken.headers.get("content-type") ?? "").includes("text/html"));
  const unknown = await app.request("/pay/NOEXISTE?t=x");
  check("Pedido inexistente → 404 HTML", unknown.status === 404 && (unknown.headers.get("content-type") ?? "").includes("text/html"));
}

db.close();
cleanup();
console.log(failures === 0 ? "\n✅ Todas las pruebas pasaron" : `\n❌ ${failures} prueba(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
