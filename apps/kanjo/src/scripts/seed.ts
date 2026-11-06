import { db } from "../db.js";
import { usdc } from "../money.js";
import { getStore, setStoreProfile } from "../store.js";

const STORE_ID = process.env.STORE_ID ?? "cafe-kanjo";
const STORE_NAME = process.env.STORE_NAME ?? "Café Kanjō";
const MERCHANT = process.env.MERCHANT_ADDRESS;
if (!MERCHANT) throw new Error("Falta MERCHANT_ADDRESS en .env");

db.prepare(
  `INSERT INTO stores (id, name, merchant_address) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET name = excluded.name, merchant_address = excluded.merchant_address`
).run(STORE_ID, STORE_NAME, MERCHANT);

const { count } = db
  .prepare("SELECT COUNT(*) AS count FROM products WHERE store_id = ?")
  .get(STORE_ID) as { count: number };

if (count === 0) {
  const insert = db.prepare(
    "INSERT INTO products (store_id, name, description, price_atomic, stock) VALUES (?, ?, ?, ?, ?)"
  );
  const products: [string, string, string, number][] = [
    ["Café americano", "Café de Chiapas, 12 oz", "0.02", 50],
    ["Latte", "Espresso doble con leche, 12 oz", "0.03", 50],
    ["Croissant", "Mantequilla, horneado del día", "0.02", 20],
    ["Café en grano 250 g", "Tueste medio, origen Veracruz", "0.10", 10],
  ];
  for (const [name, description, price, stock] of products) {
    insert.run(STORE_ID, name, description, usdc(price), stock);
  }
  console.log(`✔ ${products.length} productos creados`);
} else {
  console.log(`✔ La tienda ya tenía ${count} productos (no se duplicaron)`);
}

// Perfil de ejemplo para la tienda demo, solo si todavía no tiene uno (nunca pisa lo que la tienda llenó)
const current = db.prepare("SELECT profile FROM stores WHERE id = ?").get(STORE_ID) as { profile: string };
if (STORE_ID === "cafe-kanjo" && current.profile === "{}") {
  const result = setStoreProfile(STORE_ID, {
    businessType: "cafeteria",
    description: "Cafetería de especialidad mexicana (tienda de demostración de Kanjō).",
    address: "Mostrador de Café Kanjō (demo)",
    hours: "Lunes a domingo, 8:00 a 20:00 (demo)",
    fulfillment: "pickup",
    prepMinutes: 10,
    policies: "Tienda de demostración: los pedidos se pagan con USDC de prueba (Fuji) y no se entregan.",
    tone: "cercano y breve, de tú",
  });
  console.log(result.ok ? "✔ Perfil de ejemplo guardado" : `✘ Perfil de ejemplo inválido: ${result.problems.join("; ")}`);
}

const store = getStore(STORE_ID)!;
console.log(`✔ Tienda lista: ${STORE_NAME} (${STORE_ID}) · ${store.profile.businessType} → vendedor ${MERCHANT}`);