import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getStore, listStores } from "../store.js";
import { applyCatalog, savePreview } from "../catalog-import.js";
import { parseCatalogFile } from "../catalog-file.js";
import { formatQuantity, priceLabel } from "../units.js";

// Catálogo desde un archivo JSON (para negocios sin página web), sin poder guardar algo inválido:
//   npm run catalog:load -- <tienda> catalogo.json                      → VISTA PREVIA: valida y muestra los cambios
//   npm run catalog:load -- <tienda> catalogo.json --apply              → agrega y actualiza productos
//   npm run catalog:load -- <tienda> catalogo.json --apply --replace    → además desactiva los que no vienen en el archivo

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const replace = args.includes("--replace");
const [storeId, file] = args.filter((a) => !a.startsWith("--"));

if (!storeId || !file) {
  console.error("Uso: npm run catalog:load -- <tienda> catalogo.json [--apply] [--replace]");
  console.error("Un catálogo de ejemplo: npm run store:template -- <giro>");
  process.exit(1);
}
const store = getStore(storeId);
if (!store) {
  console.error(`✘ No existe la tienda "${storeId}". Tiendas: ${listStores().map((s) => s.id).join(", ")}`);
  process.exit(1);
}

let input: unknown;
try {
  input = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`✘ ${file} no es un JSON válido: ${(error as Error).message}`);
  process.exit(1);
}

const parsed = parseCatalogFile(input);
if (!parsed.ok) {
  console.error(`✘ El catálogo tiene problemas (no se guardó nada):\n  • ${parsed.problems.join("\n  • ")}`);
  process.exit(1);
}

const preview = savePreview({ storeId: store.id, source: `archivo:${basename(file)}`, currency: parsed.currency, items: parsed.items });
console.log(`Catálogo para ${store.name} (${parsed.items.length} productos, precios convertidos a USDC):\n`);
for (const item of parsed.items) {
  const stock = item.stock === undefined ? "" : `  · hay ${formatQuantity(item.stock, item.unit)}`;
  console.log(`  ${priceLabel(item.price_atomic, item.unit).padStart(15)}  ${item.name}${stock}`);
}
const { diff } = preview;
console.log(
  `\nCambios: +${diff.added} nuevos · ~${diff.updated} actualizados · =${diff.unchanged} iguales · ${diff.removed} en la tienda que no vienen en el archivo` +
    (diff.removed ? (replace ? " (se desactivan)" : " (se quedan; usa --replace para desactivarlos)") : "")
);

if (!apply) {
  console.log(`\nVista previa: no se guardó nada. Para guardar, repite con --apply${replace ? " --replace" : ""}`);
  process.exit(0);
}
const result = applyCatalog(preview.id, replace ? "replace" : "merge");
console.log(`\n✅ Catálogo guardado: ${result.added} nuevos, ${result.updated} actualizados, ${result.deactivated} desactivados. El agente lo usa desde el siguiente mensaje.`);
