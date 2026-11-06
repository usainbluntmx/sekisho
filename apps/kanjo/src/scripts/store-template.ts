import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TEMPLATES, TEMPLATE_TYPES } from "../templates.js";
import type { BusinessType } from "../store-profile.js";

// Plantilla por giro: escribe perfil.json y catalogo.json para editarlos (nunca sobrescribe):
//   npm run store:template                              → lista los giros
//   npm run store:template -- carniceria                → crea ./plantilla-carniceria/
//   npm run store:template -- carniceria mi-carpeta     → la crea en mi-carpeta/

const [type, dirArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

if (!type) {
  console.log("Plantillas disponibles:");
  for (const t of TEMPLATE_TYPES) console.log(`  ${t.padEnd(12)} ${TEMPLATES[t]!.label} · ${TEMPLATES[t]!.catalog.items.length} productos de ejemplo`);
  console.log("\n¿Otro giro? Usa la más parecida y cambia businessType a \"otro\" en perfil.json.");
  process.exit(0);
}

const template = TEMPLATES[type as BusinessType];
if (!template) {
  console.error(`✘ No hay plantilla "${type}". Giros: ${TEMPLATE_TYPES.join(", ")}`);
  process.exit(1);
}

const dir = resolve(dirArg ?? `plantilla-${type}`);
const files = { profile: join(dir, "perfil.json"), catalog: join(dir, "catalogo.json") };
const existing = Object.values(files).filter((f) => existsSync(f));
if (existing.length) {
  console.error(`✘ Ya existe ${existing.join(" y ")}. No se sobrescribe nada: borra o mueve esos archivos, o usa otra carpeta.`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
writeFileSync(files.profile, JSON.stringify(template.profile, null, 2) + "\n");
writeFileSync(files.catalog, JSON.stringify(template.catalog, null, 2) + "\n");

console.log(`✅ Plantilla de ${template.label} en ${dir}

1. Edita perfil.json: llena address (dirección)${"deliveryArea" in template.profile ? ", deliveryArea (zona de entrega)" : ""} y hours (horario).
2. Edita catalogo.json: tus productos, precios (en MXN) y existencias.
   • unit "kg": el precio es por kilo y stock va en kilos (2.5 = 2 kg 500 g). Sin unit = por pieza.
   • Borra los productos que no vendes; no se publica nada hasta que lo apliques.
3. Prueba sin guardar:
   npm run store:profile -- <tienda> ${files.profile}
   npm run catalog:load -- <tienda> ${files.catalog}
4. Si todo se ve bien, repite cada comando con --apply`);
