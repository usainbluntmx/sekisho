import { rmSync } from "node:fs";

// Base temporal: todo offline, sin Firecrawl ni ElevenLabs
const TEST_DB = "data/test-catalog.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(TEST_DB + suffix, { force: true });
};
cleanup();
process.env.DB_PATH = TEST_DB;

const { normalizeItems, normalizeName, resolveImageUrl, toAtomic } = await import("../catalog-normalize.js");
const { shouldReplyWithVoice, spokenText } = await import("../voice-text.js");
const { db } = await import("../db.js");
const { applyCatalog, diffAgainstStore } = await import("../catalog-import.js");
const { listProducts } = await import("../store.js");

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}
function throws(fn: () => unknown, match: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return match.test((error as Error).message);
  }
}

console.log("─── Precios ───");
check("45 MXN con FX 18.5 → 2.432432 USDC", toAtomic(45, "MXN", 18.5) === 2_432_432);
check("2.5 USD → 2500000", toAtomic(2.5, "USD") === 2_500_000);
check("0.001 USD → rechazado (mínimo 0.01)", throws(() => toAtomic(0.001, "USD"), /0\.01/));
check("EUR → rechazado (moneda no soportada)", throws(() => toAtomic(45, "EUR"), /no soportada/));
check("MXN sin FX → rechazado", throws(() => toAtomic(45, "MXN", NaN), /FX_MXN_PER_USDC/));
check("Precio 0 → rechazado", throws(() => toAtomic(0, "USD"), /inválido/));

console.log("─── Normalización ───");
check('"Café Americano" = "CAFE  americano"', normalizeName("Café Americano") === normalizeName("CAFE  americano"));
const opts = { currency: "USD", sourceUrl: "https://menu.example/carta", maxItems: 3 };
const dup = normalizeItems([{ name: "Latte", price: 3 }, { name: "LATTE ", price: 4 }], opts);
check("Nombre duplicado → 1 item + aviso", dup.items.length === 1 && dup.warnings.some((w) => /Duplicado/.test(w)));
const out = normalizeItems([{ name: "Mocha", price: 3, available: false }], opts);
check("Agotado → omitido + aviso", out.items.length === 0 && out.warnings.some((w) => /agotado/.test(w)));
const bad = normalizeItems([{ name: "Sin precio" }, { price: 2 }, { name: "Té", price: 2 }], opts);
check("Items sin nombre o precio → descartados sin romper", bad.items.length === 1 && bad.warnings.length === 2);
const many = normalizeItems([1, 2, 3, 4, 5].map((n) => ({ name: `P${n}`, price: n })), opts);
check("Tope de items → recorta y avisa", many.items.length === 3 && many.warnings.some((w) => /Recortado/.test(w)));
check("Imagen relativa → URL absoluta", resolveImageUrl("/img/latte.jpg", opts.sourceUrl) === "https://menu.example/img/latte.jpg");
check("Imagen javascript: → descartada", resolveImageUrl("javascript:alert(1)", opts.sourceUrl) === null);

console.log("─── Aplicar importación ───");
db.prepare("INSERT INTO stores (id, name, merchant_address) VALUES ('t', 'Test', '0x0000000000000000000000000000000000000001')").run();
db.prepare("INSERT INTO products (store_id, name, price_atomic, stock) VALUES ('t', 'Latte', 2000000, 5)").run();
db.prepare("INSERT INTO products (store_id, name, price_atomic, stock) VALUES ('t', 'Viejo', 1000000, 5)").run();
const items = [
  { name: "latte", description: "12 oz", price_atomic: 2_500_000, category: "Bebidas", image_url: null },
  { name: "Croissant", description: "", price_atomic: 1_500_000, category: "Pan", image_url: "https://menu.example/c.jpg" },
];
const diff = diffAgainstStore("t", items);
check("Diff: 1 nuevo, 1 actualizado, 1 fuera", diff.added === 1 && diff.updated === 1 && diff.removed === 1);
const insertPreview = (id: string) =>
  db.prepare("INSERT INTO catalog_imports (id, store_id, source_url, status, currency, payload) VALUES (?, 't', 'https://menu.example', 'preview', 'USD', ?)")
    .run(id, JSON.stringify({ items, warnings: [], diff }));
insertPreview("AAAA0001");
const applied = applyCatalog("AAAA0001");
check("Merge: 1 nuevo y 1 actualizado", applied.added === 1 && applied.updated === 1 && applied.deactivated === 0);
check("Aplicar otra vez → 'ya aplicada'", throws(() => applyCatalog("AAAA0001"), /ya aplicada/));
const after = diffAgainstStore("t", items);
check("Diff estable tras aplicar (+0 · ~0)", after.added === 0 && after.updated === 0 && after.unchanged === 2);
const croissant = listProducts("t").find((p) => p.name === "Croissant");
check("Guarda sección e imagen", croissant?.category === "Pan" && croissant?.image_url === "https://menu.example/c.jpg");
insertPreview("AAAA0002");
check("Replace desactiva lo que no viene", applyCatalog("AAAA0002", "replace").deactivated === 1 && listProducts("t").length === 2);

console.log("─── Voz ───");
check("Texto hablado sin links, formato ni emojis", spokenText("*Total:* 2.50 USDC 😊 paga aquí https://x.io/pay/1?t=abc", 600) === "Total: 2 dólares con 50 paga aquí");
check("No lee el id del pedido ni el link", spokenText("Listo, tu pedido 09D37429 suma 6.85 USDC.\n\nLink de pago: https://k.io/pay/09D37429?t=x", 600) === "Listo, tu pedido suma 6 dólares con 85.");
check("Montos hablados", spokenText("6.85 USDC, 2.00 USDC y 1 USDC", 600) === "6 dólares con 85, 2 dólares y 1 dólar");
check("Listas se leen como frases", spokenText("Tenemos:\n- Latte: 3.10 USDC\n- Mocha: 3.48 USDC", 600) === "Tenemos: Latte: 3 dólares con 10. Mocha: 3 dólares con 48");
const base = { enabled: true, inboundType: "audio", text: "Son 2 lattes, ¿confirmas?", maxChars: 600 };
check("Audio entrante → responde en voz", shouldReplyWithVoice(base));
check("Texto entrante → no responde en voz", !shouldReplyWithVoice({ ...base, inboundType: "text" }));
check("Respuesta con link → texto", !shouldReplyWithVoice({ ...base, text: "Paga en https://kanjo.example/pay/1" }));
check("Respuesta larga → texto", !shouldReplyWithVoice({ ...base, maxChars: 10 }));
check("Función apagada → texto", !shouldReplyWithVoice({ ...base, enabled: false }));

db.close();
cleanup();
console.log(failures === 0 ? "\n✅ Todas las pruebas pasaron" : `\n❌ ${failures} prueba(s) fallaron`);
if (failures > 0) process.exitCode = 1;
