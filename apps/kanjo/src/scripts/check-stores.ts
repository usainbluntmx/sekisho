import { rmSync } from "node:fs";

// Base de datos temporal, aislada de data/kanjo.db
const TEST_DB = "data/test-stores.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(TEST_DB + suffix, { force: true });
};
cleanup();
process.env.DB_PATH = TEST_DB;
process.env.STORE_ID = "cafe-kanjo";

const { db } = await import("../db.js");
const store = await import("../store.js");

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}

const WALLET_A = "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae";
const WALLET_B = "0xa0B6Ce98E5744E0B7523F9e2DA67d73b24727485";
const problems = (input: Parameters<typeof store.validateNewStore>[0]) => store.validateNewStore(input).join(" | ");

console.log("─── Alta de tiendas ───");
check("Una tienda válida no tiene problemas", problems({ id: "cafe-kanjo", name: "Café Kanjō", merchant: WALLET_A }) === "");
check("Id con mayúsculas o espacios → error", /id:/.test(problems({ id: "Don Pepe", name: "Don Pepe", merchant: WALLET_A })));
check("Id muy corto → error", /id:/.test(problems({ id: "ab", name: "Don Pepe", merchant: WALLET_A })));
check("Id con guion al final → error", /id:/.test(problems({ id: "don-pepe-", name: "Don Pepe", merchant: WALLET_A })));
check("Nombre vacío → error", /nombre/.test(problems({ id: "don-pepe", name: " ", merchant: WALLET_A })));
check("Wallet incompleta → error", /no es una dirección válida/.test(problems({ id: "don-pepe", name: "Don Pepe", merchant: "0x1234" })));
check("Wallet 0x000… → error", /0x000/.test(problems({ id: "don-pepe", name: "Don Pepe", merchant: "0x0000000000000000000000000000000000000000" })));
check(
  "Wallet con mayúsculas mal copiadas (checksum) → error",
  /checksum/.test(problems({ id: "don-pepe", name: "Don Pepe", merchant: WALLET_A.replace("Adc", "ADc") }))
);
check("Wallet en minúsculas es válida", problems({ id: "don-pepe", name: "Don Pepe", merchant: WALLET_B.toLowerCase() }) === "");
check("Perfil inválido → error con su explicación", /perfil · .*zona de entrega/.test(problems({ id: "don-pepe", name: "Don Pepe", merchant: WALLET_B, profile: { businessType: "carniceria", fulfillment: "delivery" } })));

const cafe = store.createStore({ id: "cafe-kanjo", name: "Café Kanjō", merchant: WALLET_A });
check("Crear la tienda por defecto", cafe.ok);
const bad = store.createStore({ id: "don-pepe", name: "Don Pepe", merchant: WALLET_B, profile: { fulfillment: "dron" } });
check("Con algo inválido NO se crea nada", !bad.ok && store.getStore("don-pepe") === undefined);
const pepe = store.createStore({
  id: "don-pepe",
  name: "Carnicería Don Pepe",
  merchant: WALLET_B.toLowerCase(),
  profile: { businessType: "carniceria", fulfillment: "pickup", address: "Av. Juárez 123" },
});
check("Crear una segunda tienda con perfil", pepe.ok && store.getStore("don-pepe")?.profile.address === "Av. Juárez 123");
check("La wallet se guarda con checksum", store.getStore("don-pepe")?.merchant_address === WALLET_B);
check("Id repetido → error", /ya existe/.test(problems({ id: "don-pepe", name: "Otra", merchant: WALLET_A })));
check("Las dos tiendas aparecen en la lista", store.listStores().map((s) => s.id).sort().join(",") === "cafe-kanjo,don-pepe");

console.log("─── Catálogos separados ───");
db.prepare("INSERT INTO products (store_id, name, price_atomic, stock) VALUES ('cafe-kanjo', 'Americano', 2430000, 10)").run();
db.prepare("INSERT INTO products (store_id, name, price_atomic, stock) VALUES ('don-pepe', 'Arrachera 1 kg', 15000000, 5)").run();
check("El café solo ve su menú", store.listProducts("cafe-kanjo").map((p) => p.name).join() === "Americano");
check("La carnicería solo ve su menú", store.listProducts("don-pepe").map((p) => p.name).join() === "Arrachera 1 kg");

console.log("─── Tienda de cada cliente ───");
check("Un cliente nuevo habla con la tienda por defecto", store.getCustomerStore("5215550001")?.id === "cafe-kanjo");
check("Cambiar a otra tienda", store.setCustomerStore("5215550001", "don-pepe") && store.getCustomerStore("5215550001")?.id === "don-pepe");
store.upsertCustomer("5215550001", "Ana");
check("Actualizar el nombre no le cambia la tienda", store.getCustomerStore("5215550001")?.id === "don-pepe");
check("Otro cliente sigue en la tienda por defecto", store.getCustomerStore("5215550002")?.id === "cafe-kanjo");
check("Cambiar a una tienda inexistente → no cambia nada", !store.setCustomerStore("5215550001", "no-existe") && store.getCustomerStore("5215550001")?.id === "don-pepe");

console.log("─── Comando /tienda ───");
const { handleMessage } = await import("../bot.js");
const { saveExchange, getHistory } = await import("../memory.js");
const said: string[] = [];
const send = async (_to: string, text: string) => {
  said.push(text);
};
saveExchange("5215550003", "¿tienen americano?", "Sí, 2.43 USDC");
await handleMessage({ from: "5215550003", name: "Luis", type: "text", text: "/tienda don-pepe" }, send);
check("/tienda <id> cambia de tienda y saluda con su nombre", store.getCustomerStore("5215550003")?.id === "don-pepe" && /Carnicería Don Pepe/.test(said.at(-1) ?? ""));
check("…y borra la conversación con la tienda anterior", getHistory("5215550003").length === 0);
await handleMessage({ from: "5215550003", name: "Luis", type: "text", text: "/tienda no-existe" }, send);
check("/tienda con un id que no existe → aviso, sin cambiar", /No encontré/.test(said.at(-1) ?? "") && store.getCustomerStore("5215550003")?.id === "don-pepe");

db.close();
cleanup();
console.log(failures === 0 ? "\n✅ Todas las pruebas pasaron" : `\n❌ ${failures} prueba(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
