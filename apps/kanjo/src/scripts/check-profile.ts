import { rmSync } from "node:fs";

// Base de datos temporal, aislada de data/kanjo.db
const TEST_DB = "data/test-profile.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(TEST_DB + suffix, { force: true });
};
cleanup();
process.env.DB_PATH = TEST_DB;

const { db } = await import("../db.js");
const store = await import("../store.js");
const { validateProfile, fulfillmentLine, profileForPrompt, EMPTY_PROFILE } = await import("../store-profile.js");

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}

const carniceria = {
  businessType: "carniceria",
  description: "Carnicería de barrio",
  address: "Av. Juárez 123",
  hours: "Lun a sáb 7:00–15:00",
  fulfillment: "both",
  deliveryArea: "Centro y Roma",
  prepMinutes: 20,
};

console.log("─── Validación ───");
const ok = validateProfile(carniceria);
check("Un perfil completo es válido", ok.ok);
check("Lo que no se llena toma su valor por defecto", ok.ok && ok.profile.policies === "" && ok.profile.tone === "");

const problems = (input: unknown) => {
  const r = validateProfile(input);
  return r.ok ? "" : r.problems.join(" | ");
};
check("Giro inexistente → error que dice cuáles valen", /giro: debe ser uno de .*carniceria/.test(problems({ ...carniceria, businessType: "joyeria" })));
check("Con entrega, falta la zona → error claro", /zona de entrega/.test(problems({ ...carniceria, deliveryArea: "" })));
check("Para recoger, falta la dirección → error claro", /dirección/.test(problems({ businessType: "abarrotes", fulfillment: "pickup" })));
check("Solo entrega a domicilio no exige dirección", validateProfile({ businessType: "abarrotes", fulfillment: "delivery", deliveryArea: "Centro" }).ok);
check("Un campo mal escrito se rechaza (no se pierde en silencio)", /campos que no existen: horario/.test(problems({ ...carniceria, horario: "x" })));
check("Tiempo de preparación con decimales → error", /tiempo de preparación/.test(problems({ ...carniceria, prepMinutes: 7.5 })));
check("Texto demasiado largo → error con el máximo", /máximo 400/.test(problems({ ...carniceria, description: "x".repeat(401) })));

console.log("─── Guardar sin romper ───");
db.prepare("INSERT INTO stores (id, name, merchant_address) VALUES ('don-pepe', 'Carnicería Don Pepe', '0x0000000000000000000000000000000000000001')").run();
check("Una tienda nueva arranca con el perfil vacío", JSON.stringify(store.getStore("don-pepe")!.profile) === JSON.stringify(EMPTY_PROFILE));
check("Guardar un perfil válido", store.setStoreProfile("don-pepe", carniceria).ok);
const bad = store.setStoreProfile("don-pepe", { ...carniceria, fulfillment: "dron" });
check("Un perfil inválido NO se guarda…", !bad.ok);
check("…y el perfil anterior queda intacto", store.getStore("don-pepe")!.profile.fulfillment === "both");
check("Guardar en una tienda inexistente → error", !store.setStoreProfile("no-existe", carniceria).ok);
db.prepare("UPDATE stores SET profile = '{no es json' WHERE id = 'don-pepe'").run();
check("Un perfil dañado en la base no tumba al agente (se usa uno vacío)", store.getStore("don-pepe")!.profile.businessType === "otro");

console.log("─── Lo que ve el agente y el cliente ───");
const p = (ok as { profile: any }).profile;
const prompt = profileForPrompt(p);
check("El agente recibe giro, horario, entrega y tiempo", /carnicería/.test(prompt) && /7:00–15:00/.test(prompt) && /domicilio/.test(prompt) && /20 min/.test(prompt));
const empty = profileForPrompt(EMPTY_PROFILE);
check("Sin horario ni tiempo, el agente lee 'no registrado'", /Horario: no registrado/.test(empty) && /preparación: no registrado/.test(empty));
check("Recoger: el cliente lee la dirección y el tiempo", fulfillmentLine({ ...p, fulfillment: "pickup" }) === "Recógelo en Av. Juárez 123. Estará listo en unos 20 min.");
check("Entrega: el cliente lee la zona", /entrega a domicilio \(Centro y Roma\)/.test(fulfillmentLine({ ...p, fulfillment: "delivery" })));
check("Sin dirección: no se inventa nada", fulfillmentLine(EMPTY_PROFILE) === "La tienda te confirmará dónde recogerlo.");

db.close();
cleanup();
console.log(failures === 0 ? "\n✅ Todas las pruebas pasaron" : `\n❌ ${failures} prueba(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
