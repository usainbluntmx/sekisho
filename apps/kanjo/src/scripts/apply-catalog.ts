import { applyCatalog } from "../catalog-import.js";

// Uso: npm run catalog:apply -- <id> [--replace]
const [id, ...flags] = process.argv.slice(2);
if (!id) {
  console.error("Uso: npm run catalog:apply -- <id> [--replace]");
  process.exit(1);
}
const mode = flags.includes("--replace") ? "replace" : "merge";
try {
  const result = applyCatalog(id, mode);
  console.log(`✔ Import ${id.toUpperCase()} aplicado (${mode}): ${result.added} nuevos, ${result.updated} actualizados, ${result.deactivated} desactivados`);
  if (result.unitChanged.length) console.log(`⚠️ Cambiaron de unidad (pieza ↔ kg) y su stock se reinició: ${result.unitChanged.join(", ")}`);
} catch (error) {
  console.error(`✘ ${(error as Error).message}`);
  process.exit(1);
}
