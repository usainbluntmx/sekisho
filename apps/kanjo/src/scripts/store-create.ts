import { readFileSync } from "node:fs";
import { createStore, listStores, validateNewStore } from "../store.js";
import { BUSINESS_TYPES, fulfillmentLine, validateProfile } from "../store-profile.js";

// Alta de una tienda, sin tocar la base a mano y sin poder guardar algo inválido:
//   npm run store:create -- <id> "<nombre>" <wallet> [perfil.json]           → VISTA PREVIA: valida y muestra cómo quedaría
//   npm run store:create -- <id> "<nombre>" <wallet> [perfil.json] --apply   → la crea (solo si todo es válido)
// La wallet es la del vendedor: ahí terminan sus ventas (a través de su SplitVault). Revisa que sea suya.

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [id, name, merchant, file] = args.filter((a) => !a.startsWith("--"));

if (!id || !name || !merchant) {
  console.error('Uso: npm run store:create -- <id> "<nombre>" <wallet del vendedor> [perfil.json] [--apply]');
  console.error('Ejemplo: npm run store:create -- carniceria-don-pepe "Carnicería Don Pepe" 0xAbC… perfil.json');
  console.error(`\nTiendas actuales: ${listStores().map((s) => s.id).join(", ") || "ninguna"}`);
  process.exit(1);
}

let profile: unknown;
if (file) {
  try {
    profile = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`✘ ${file} no es un JSON válido: ${(error as Error).message}`);
    process.exit(1);
  }
}

const problems = validateNewStore({ id, name, merchant, profile });
if (problems.length) {
  console.error(`✘ La tienda tiene problemas (no se guardó nada):\n  • ${problems.join("\n  • ")}`);
  process.exit(1);
}

const parsed = profile === undefined ? undefined : validateProfile(profile);
const prof = parsed?.ok ? parsed.profile : undefined;
console.log(`Tienda nueva:
  id:       ${id}
  nombre:   ${name}
  vendedor: ${merchant}
  giro:     ${prof ? BUSINESS_TYPES[prof.businessType] : "sin perfil (lo puedes agregar después con npm run store:profile)"}`);
if (prof) console.log(`  al pagar, el cliente lee: "${fulfillmentLine(prof)}"`);
console.log(`\n⚠️ Revisa la wallet del vendedor letra por letra: las ventas de esta tienda se cobran ahí.`);

if (!apply) {
  console.log("\nVista previa: no se guardó nada. Para crearla, repite con --apply");
  process.exit(0);
}

const result = createStore({ id, name, merchant, profile });
if (!result.ok) {
  console.error(`\n✘ No se creó: ${result.problems.join("; ")}`);
  process.exit(1);
}
const base = (process.env.PUBLIC_BASE_URL ?? "https://kanjo.zerotwolabs.xyz").replace(/\/$/, "");
console.log(`\n✅ Tienda creada: ${result.store.name} (${result.store.id})
Siguiente:
  • Catálogo:  npm run catalog:import -- <url> --store ${id}
  • Perfil:    npm run store:profile -- ${id} perfil.json
  • Voz web:   ${base}/voice?store=${id}
  • WhatsApp:  el cliente escribe "/tienda ${id}"
  • Agentes:   herramienta MCP menu con store_id "${id}"`);
