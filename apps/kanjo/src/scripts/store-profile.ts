import { readFileSync } from "node:fs";
import { getStore, listStores, setStoreProfile } from "../store.js";
import { BUSINESS_TYPES, fulfillmentLine, validateProfile, type StoreProfile } from "../store-profile.js";

// Perfil de negocio, sin tocar la base a mano y sin poder guardar algo inválido:
//   npm run store:profile                                   → lista las tiendas
//   npm run store:profile -- <tienda>                       → muestra su perfil y qué le falta
//   npm run store:profile -- <tienda> perfil.json           → VISTA PREVIA: valida y muestra los cambios
//   npm run store:profile -- <tienda> perfil.json --apply   → guarda (solo si es válido)
//   npm run -s store:profile -- --example > perfil.json     → un perfil de ejemplo para editar (-s: sin el encabezado de npm)

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [storeId, file] = args.filter((a) => !a.startsWith("--"));

const EXAMPLE: StoreProfile = {
  businessType: "carniceria",
  description: "Carnicería de barrio: res, cerdo y pollo frescos.",
  address: "Av. Juárez 123, local 4, Centro",
  hours: "Lunes a sábado, 7:00 a 15:00",
  fulfillment: "both",
  deliveryArea: "Colonias Centro y Roma, pedido mínimo 150 MXN",
  prepMinutes: 20,
  policies: "Cortes al gusto. No hay cambios en producto ya cortado.",
  tone: "amable y directo, de usted",
};

function missing(p: StoreProfile): string[] {
  const out: string[] = [];
  if (p.businessType === "otro") out.push("giro (businessType)");
  if (!p.description) out.push("descripción");
  if (!p.hours) out.push("horario");
  if (!p.prepMinutes) out.push("tiempo de preparación (prepMinutes)");
  if (p.fulfillment !== "delivery" && !p.address) out.push("dirección para recoger");
  if (p.fulfillment !== "pickup" && !p.deliveryArea) out.push("zona de entrega");
  return out;
}

function show(p: StoreProfile): void {
  console.log(JSON.stringify(p, null, 2));
  const gaps = missing(p);
  console.log(gaps.length ? `\n⚠️ Falta: ${gaps.join(", ")}. El agente dirá que lo confirma con la tienda.` : "\n✅ Perfil completo");
  console.log(`\nAl pagar, el cliente lee: "${fulfillmentLine(p)}"`);
}

if (args.includes("--example")) {
  console.log(JSON.stringify(EXAMPLE, null, 2));
  // La ayuda va a stderr: así "> perfil.json" guarda solo el JSON
  console.error(`\nGiros: ${Object.keys(BUSINESS_TYPES).join(", ")} · entrega: pickup, delivery, both`);
  process.exit(0);
}

if (!storeId) {
  for (const s of listStores()) console.log(`${s.id} · ${s.name} · ${BUSINESS_TYPES[s.profile.businessType]}`);
  process.exit(0);
}

const store = getStore(storeId);
if (!store) {
  console.error(`✘ No existe la tienda "${storeId}". Tiendas: ${listStores().map((s) => s.id).join(", ")}`);
  process.exit(1);
}

if (!file) {
  console.log(`Perfil de ${store.name} (${store.id}):\n`);
  show(store.profile);
  process.exit(0);
}

let input: unknown;
try {
  input = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`✘ ${file} no es un JSON válido: ${(error as Error).message}`);
  process.exit(1);
}

const result = validateProfile(input);
if (!result.ok) {
  console.error(`✘ El perfil tiene problemas (no se guardó nada):\n  • ${result.problems.join("\n  • ")}`);
  process.exit(1);
}

const before = store.profile as Record<string, unknown>;
const after = result.profile as Record<string, unknown>;
const changes = Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
console.log(changes.length ? `Cambios en ${store.name}:` : "Sin cambios.");
for (const k of changes) console.log(`  ${k}: ${JSON.stringify(before[k] ?? null)} → ${JSON.stringify(after[k] ?? null)}`);
console.log("");
show(result.profile);

if (!apply) {
  console.log("\nVista previa: no se guardó nada. Para guardar, repite con --apply");
  process.exit(0);
}
const saved = setStoreProfile(store.id, input);
console.log(saved.ok ? `\n✅ Perfil guardado. El agente lo usa desde el siguiente mensaje.` : `\n✘ No se guardó: ${saved.problems.join("; ")}`);
process.exit(saved.ok ? 0 : 1);
