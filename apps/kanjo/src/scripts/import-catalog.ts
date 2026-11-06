import { DEFAULT_STORE_ID, getStore } from "../store.js";
import { applyCatalog, previewCatalog } from "../catalog-import.js";
import { priceLabel } from "../units.js";

// Uso: npm run catalog:import -- <url> [--store <id>] [--apply] [--replace]
const argv = process.argv.slice(2);
const storeFlag = argv.indexOf("--store");
const STORE_ID = storeFlag >= 0 ? argv[storeFlag + 1] ?? "" : DEFAULT_STORE_ID;
const [url, ...flags] = argv.filter((a, i) => i !== storeFlag && i !== storeFlag + 1);
if (!url) {
  console.error("Uso: npm run catalog:import -- <url> [--store <id>] [--apply] [--replace]");
  process.exit(1);
}
if (!getStore(STORE_ID)) {
  console.error(`La tienda "${STORE_ID}" no existe. Créala con npm run store:create o corre npm run seed.`);
  process.exit(1);
}

console.log(`Leyendo ${url} con Firecrawl…`);
const started = Date.now();
const preview = await previewCatalog(STORE_ID, url);

console.log(`\nImport ${preview.id} · ${preview.store_name ?? "(sin nombre)"} · ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`Moneda de la página: ${preview.currency} · ${preview.items.length} productos\n`);
let category = "";
for (const item of preview.items.slice(0, 30)) {
  if (item.category !== category) {
    category = item.category;
    console.log(`  ${category || "(sin sección)"}`);
  }
  console.log(`    ${priceLabel(item.price_atomic, item.unit).padStart(15)}  ${item.name}${item.image_url ? "  🖼" : ""}`);
}
if (preview.items.length > 30) console.log(`    … y ${preview.items.length - 30} más`);
console.log(
  `\nDiff: +${preview.diff.added} nuevos · ~${preview.diff.updated} actualizados · ` +
    `=${preview.diff.unchanged} iguales · -${preview.diff.removed} fuera de esta página`
);
if (preview.warnings.length) {
  console.log(`\nAvisos (${preview.warnings.length}):`);
  for (const warning of preview.warnings.slice(0, 10)) console.log(`  · ${warning}`);
}

if (flags.includes("--apply")) {
  const mode = flags.includes("--replace") ? "replace" : "merge";
  const result = applyCatalog(preview.id, mode);
  console.log(`\n✔ Aplicado (${mode}): ${result.added} nuevos, ${result.updated} actualizados, ${result.deactivated} desactivados`);
  if (result.unitChanged.length) console.log(`⚠️ Cambiaron de unidad (pieza ↔ kg) y su stock se reinició: ${result.unitChanged.join(", ")}`);
} else {
  console.log(`\nVista previa guardada; la base no cambió. Aplica con: npm run catalog:apply -- ${preview.id}`);
}
