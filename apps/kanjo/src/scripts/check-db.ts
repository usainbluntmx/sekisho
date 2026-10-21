import { createOrder, getOrder, listProducts, markOrderPaid, upsertCustomer } from "../store.js";
import { formatUsdc } from "../money.js";

const STORE_ID = process.env.STORE_ID ?? "cafe-kanjo";
const CUSTOMER = "5215500000000";

const products = listProducts(STORE_ID);
console.log("Catálogo:");
for (const p of products) {
  console.log(`  #${p.id} ${p.name} — ${formatUsdc(p.price_atomic)} USDC (stock ${p.stock})`);
}

upsertCustomer(CUSTOMER, "Cliente de prueba");

// Pedido: 2 americanos + 1 croissant
const { order, items } = createOrder(STORE_ID, CUSTOMER, [
  { productId: products[0].id, quantity: 2 },
  { productId: products[2].id, quantity: 1 },
]);
console.log(`\nPedido ${order.id} (${order.status}):`);
for (const i of items) console.log(`  ${i.quantity} × ${i.name}`);
console.log(`  Total: ${formatUsdc(order.total_atomic)} USDC`);

// Simula el pago
console.log("\n¿Marcado como pagado?:", markOrderPaid(order.id, "0xTEST"));
console.log("¿Segundo intento (debe ser false)?:", markOrderPaid(order.id, "0xTEST"));
console.log("Estado final:", getOrder(order.id)?.order.status);

const after = listProducts(STORE_ID);
console.log(`\nStock ${after[0].name}: ${products[0].stock} → ${after[0].stock}`);