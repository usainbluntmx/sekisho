import { rmSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";

// Base temporal; Telegram simulado (nada sale a la red)
const TEST_DB = "data/test-onboarding.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(TEST_DB + suffix, { force: true });
};
cleanup();
process.env.DB_PATH = TEST_DB;
process.env.OPERATOR_PRIVATE_KEY ??= generatePrivateKey();
process.env.MERCHANT_ONBOARDING = "on";
process.env.KANJO_ADMIN_ID = "tg-1";
process.env.FX_MXN_PER_USDC = "18.5";
process.env.TELEGRAM_BOT_TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ ok: true, result: { username: "kanjo_test_bot" } }), { status: 200 })) as typeof fetch;

const { db } = await import("../db.js");
const store = await import("../store.js");
const { handleMerchant, slugFor, skipsChatLimit, expireStaleDrafts } = await import("../onboarding.js");
const { parseCatalogLines } = await import("../catalog-lines.js");
const { enqueueOrderPaid } = await import("../notify.js");

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}

const ADMIN = "tg-1";
const PEPE = "tg-2";
const CLIENTE = "tg-3";
const WALLET = "0xa0B6Ce98E5744E0B7523F9e2DA67d73b24727485";
const say = async (from: string, text: string) => (await handleMerchant(from, text))?.join("\n---\n") ?? null;
const outbox = (prefix: string) =>
  db.prepare("SELECT recipient, body FROM outbox WHERE dedupe_key LIKE ? || '%' ORDER BY id DESC").get(prefix) as { recipient: string; body: string } | undefined;
const pepeStore = () => store.getStoreByOwner(PEPE)!;

db.prepare("INSERT INTO stores (id, name, merchant_address) VALUES ('cafe-kanjo', 'Café Kanjō', '0x0000000000000000000000000000000000000001')").run();
for (const id of [ADMIN, PEPE, CLIENTE]) store.upsertCustomer(id, "Persona");

console.log("─── Productos escritos en el chat ───");
const lines = parseCatalogLines("Arrachera, 380, kg, 10\n- Chorizo, $160 mxn, kg\nMartillo, 185, 6", 18.5);
check("3 renglones → 3 productos (kg con existencias, viñetas y $ se limpian)", lines.ok && lines.items.length === 3 && lines.items[0].unit === "kg" && lines.items[0].stock === 10_000 && lines.items[1].price_atomic === 8_650_000);
check("Sin existencias → las de siempre (20)", lines.ok && lines.items[1].stock === 20_000 && lines.items[2].stock === 6);
const bad = parseCatalogLines("Arrachera\nChorizo, 160, docena", 18.5);
check("Sin precio o con una palabra rara → error con el producto", !bad.ok && /producto 1 \(Arrachera\) · falta el precio/.test(bad.problems.join()) && /no entendí "docena"/.test(bad.problems.join()));
check("Un precio con letras → error claro", !parseCatalogLines("Martillo, ciento ochenta", 18.5).ok);

console.log("─── Alta paso a paso ───");
check("Sin /vender, un mensaje normal va al agente (null)", (await say(CLIENTE, "hola")) === null);
check("El canal web no puede dar de alta tiendas", (await say("web-abc", "/vender")) === null);
check("/vender pregunta el nombre", /cómo se llama tu negocio/i.test((await say(PEPE, "/vender"))!));
check("Nombre → pregunta el giro con números", /1\. cafetería/.test((await say(PEPE, "Carnicería Don Pepe"))!));
check("Giro fuera de rango → lo vuelve a pedir", /número del 1 al 5/.test((await say(PEPE, "9"))!));
check("Giro 4 (carnicería) → pregunta la entrega", /Pasan a recogerlo/.test((await say(PEPE, "4"))!));
check("Las dos → pide la dirección", /dirección/.test((await say(PEPE, "3"))!));
check("Dirección → pide la zona de entrega", /zona/.test((await say(PEPE, "Av. Juárez 123, Centro"))!));
check("Zona → pide el horario", /horario/i.test((await say(PEPE, "Centro y Roma"))!));
check("Un comando a mitad del alta no se toma como respuesta", /no aplica en este paso/.test((await say(PEPE, "/probar"))!));
check("Horario → pide el tiempo de preparación", /minutos/.test((await say(PEPE, "Lunes a sábado, 7:00 a 15:00"))!));
check("Tiempo con letras → lo vuelve a pedir", /solo los minutos/.test((await say(PEPE, "veinte"))!));
check("Tiempo → pide la wallet (y avisa que no se cambia por chat)", /no se puede cambiar desde el chat/.test((await say(PEPE, "20"))!));
check("Wallet incompleta → error", /no es una dirección válida/.test((await say(PEPE, "0x1234"))!));
check("Wallet con mayúsculas mal copiadas → error de checksum", /checksum/.test((await say(PEPE, WALLET.replace("a0B6", "A0B6")))!));
check("Wallet válida → pide los últimos 4 caracteres", /últimos 4/.test((await say(PEPE, WALLET))!));
check("Últimos 4 equivocados → la vuelve a pedir completa", /No coinciden/.test((await say(PEPE, "0000"))!));
await say(PEPE, WALLET);
check("Últimos 4 correctos → pide productos con ejemplos de su giro", /Arrachera, 380, kg, 10/.test((await say(PEPE, "7485"))!));
check("Lista con errores → no guarda y explica", /no guardé nada[\s\S]*falta el precio/.test((await say(PEPE, "Arrachera, 380, kg, 10\nChorizo"))!));
const preview = (await say(PEPE, "Arrachera, 380, kg, 10\nChorizo, 160, kg"))!;
check("Lista válida → vista previa en USDC con el precio en pesos de vuelta", /Arrachera — 20.54 USDC \/ kg \(≈380 MXN\) · hay 10 kg/.test(preview) && store.getStoreByOwner(PEPE) === undefined);
check("«sí» → crea el borrador", /quedó como borrador/.test((await say(PEPE, "sí"))!));
const draft = pepeStore();
check("Borrador con su dueño, contacto, wallet, perfil y 2 productos por kilo", draft.status === "draft" && draft.owner === PEPE && draft.contact === PEPE && draft.merchant_address === WALLET && draft.profile.address === "Av. Juárez 123, Centro" && draft.profile.prepMinutes === 20 && store.listProducts(draft.id).length === 2 && store.listProducts(draft.id)[0].unit === "kg");
check("Id para el link a partir del nombre", draft.id === "carniceria-don-pepe");

console.log("─── Un borrador no lo ve nadie más ───");
check("No aparece en la lista para clientes y agentes", !store.listPublishedStores().some((s) => s.id === draft.id));
check("Otro cliente no puede entrar a la tienda", !store.setCustomerStore(CLIENTE, draft.id) && store.getCustomerStore(CLIENTE)?.id === "cafe-kanjo");
await say(PEPE, "/vender");
check("/probar: el dueño sí entra, como cliente", /como si fueras un cliente/.test((await say(PEPE, "/probar"))!) && store.getCustomerStore(PEPE)?.id === draft.id);
check("Después de /probar, sus mensajes van al agente", (await say(PEPE, "quiero medio kilo de arrachera")) === null);

console.log("─── Revisión ───");
await say(PEPE, "/vender");
check("/enviar → en revisión", /Enviada/.test((await say(PEPE, "/enviar"))!) && pepeStore().status === "pending");
const review = outbox("store-review:");
check("Al administrador le llega el resumen con wallet, productos y /aprobar", review?.recipient === ADMIN && review.body.includes(WALLET) && /Arrachera/.test(review.body) && review.body.includes(`/aprobar ${draft.id}`));
check("Un cliente que escribe /aprobar no aprueba nada (va al agente)", (await say(CLIENTE, `/aprobar ${draft.id}`)) === null && pepeStore().status === "pending");
check("/aprobar sin id → pide el id y dice cuáles están en revisión", /Falta el id[\s\S]*carniceria-don-pepe/.test((await say(ADMIN, "/aprobar"))!) && pepeStore().status === "pending");
check("El administrador no cuenta para el límite de mensajes", skipsChatLimit(ADMIN, "/pendientes") && !skipsChatLimit(CLIENTE, "hola"));
check("/pendientes la lista", /Carnicería Don Pepe — \/ver carniceria-don-pepe/.test((await say(ADMIN, "/pendientes"))!));
check("/rechazar sin motivo → lo pide", /Escribe el motivo/.test((await say(ADMIN, `/rechazar ${draft.id}`))!));
await say(ADMIN, `/rechazar ${draft.id} Agrega el precio del bistec`);
check("/rechazar con motivo → borrador y el comerciante recibe el motivo", pepeStore().status === "draft" && /Agrega el precio del bistec/.test(outbox("store-rejected:")?.body ?? ""));
await say(PEPE, "/vender");
await say(PEPE, "/productos");
await say(PEPE, "Arrachera, 380, kg, 10\nBistec de res, 220, kg, 15");
check("/productos reemplaza el catálogo (1 nuevo, 1 actualizado, 1 quitado)", /1 nuevos, 1 actualizados, 1 quitados/.test((await say(PEPE, "si"))!));
await say(PEPE, "/enviar");
check("/aprobar → publicada", /publicada/.test((await say(ADMIN, `/aprobar ${draft.id}`))!) && pepeStore().status === "published");
check("El comerciante recibe su link de Telegram", (outbox("store-approved:")?.body ?? "").includes("https://t.me/kanjo_test_bot?start=carniceria-don-pepe") && outbox("store-approved:")?.recipient === PEPE);
check("Publicada: aparece para clientes y agentes, y un cliente puede entrar", store.listPublishedStores().some((s) => s.id === draft.id) && store.setCustomerStore(CLIENTE, draft.id));
await say(PEPE, "/vender");
check("Una tienda publicada no se borra desde el chat", /no se puede borrar/.test((await say(PEPE, "/cancelar"))!) && Boolean(store.getStore(draft.id)));

console.log("─── Avisos de sus pedidos ───");
const product = store.listProducts(draft.id)[0];
const order = store.createOrder(draft.id, CLIENTE, [{ productId: product.id, quantity: 0.5 }]);
store.markOrderPaid(order.order.id, "0xabc");
enqueueOrderPaid(order.order.id);
check("El aviso de pedido pagado le llega al dueño (no a MERCHANT_WA_ID)", outbox(`order-paid:${order.order.id}:merchant`)?.recipient === PEPE);

console.log("─── Cancelar y límites ───");
// Un borrador con un pedido de /probar sin pagar sí se puede borrar
const tryOwner = "tg-7";
store.upsertCustomer(tryOwner, "Prueba");
await say(tryOwner, "/vender");
check("Quien está en medio del alta no cuenta para el límite", skipsChatLimit(tryOwner, "Abarrotes Lupita"));
for (const answer of ["Abarrotes Lupita", "2", "1", "Calle 5 número 10", "saltar", "saltar", WALLET, "7485", "Leche 1 L, 28, 10", "sí"]) await say(tryOwner, answer);
const lupita = store.getStoreByOwner(tryOwner)!;
check("La lista de giros dice «otro giro», no «negocio»", /5\. otro giro/.test((await say("tg-8", "/vender")) + ((await say("tg-8", "Tienda X")) ?? "")));
await say("tg-8", "/cancelar");
store.createOrder(lupita.id, tryOwner, [{ productId: store.listProducts(lupita.id)[0].id, quantity: 1 }]);
await say(tryOwner, "/vender");
check("/cancelar borra un borrador con pedidos de prueba sin pagar", /Borré tu borrador/.test((await say(tryOwner, "/cancelar"))!) && store.getStore(lupita.id) === undefined);
const pending = store.createStore({ id: "con-pago", name: "Con pago", merchant: WALLET, status: "draft", owner: "tg-9" });
const paidProduct = Number(db.prepare("INSERT INTO products (store_id, name, price_atomic, stock) VALUES ('con-pago', 'x', 1000000, 5)").run().lastInsertRowid);
store.upsertCustomer("tg-9", "x");
const paidOrder = store.createOrder("con-pago", "tg-9", [{ productId: paidProduct, quantity: 1 }]);
store.markOrderPaid(paidOrder.order.id, "0xdef");
check("Un borrador con un pedido PAGADO no se borra", pending.ok && !store.deleteUnpublishedStore("con-pago") && Boolean(store.getStore("con-pago")));
await say("tg-4", "/vender");
check("/cancelar antes de crear la tienda → borra el avance", /Borré tu borrador/.test((await say("tg-4", "/cancelar"))!) && (await say("tg-4", "hola")) === null);
check("Otra tienda con el mismo nombre → otro id (-2)", slugFor("Carnicería Don Pepe") === "carniceria-don-pepe-2");
check("Un nombre que es comando no se vuelve id", slugFor("Vender") === "vender-2" && store.validateNewStore({ id: "vender", name: "x y", merchant: WALLET }).some((p) => /reservado/.test(p)));
console.log("─── Borradores abandonados ───");
{
  const old = (id: string, owner: string, status: "draft" | "pending" = "draft") => {
    store.createStore({ id, name: `Tienda ${id}`, merchant: WALLET, status, owner });
    db.prepare("UPDATE stores SET created_at = datetime('now', '-20 days') WHERE id = ?").run(id);
  };
  old("vieja-sola", "tg-20");
  old("vieja-activa", "tg-21");
  db.prepare("INSERT INTO onboarding (owner, step, data) VALUES ('tg-21', 'catalog', '{}')").run(); // siguió editando hoy
  old("vieja-revision", "tg-22", "pending");
  store.createStore({ id: "nueva", name: "Tienda nueva", merchant: WALLET, status: "draft", owner: "tg-23" });
  db.prepare("UPDATE stores SET created_at = datetime('now', '-20 days') WHERE id = 'con-pago'").run();
  db.prepare("INSERT INTO onboarding (owner, step, data, updated_at) VALUES ('tg-24', 'hours', '{}', datetime('now', '-20 days'))").run();

  const removed = expireStaleDrafts(14);
  check("Un borrador sin movimiento en 14 días se borra", removed.includes("vieja-sola") && store.getStore("vieja-sola") === undefined);
  check("…y su dueño recibe el aviso", outbox("store-expired:vieja-sola")?.recipient === "tg-20" && /\/vender/.test(outbox("store-expired:vieja-sola")?.body ?? ""));
  check("Un borrador viejo cuyo dueño sigue editando se conserva", Boolean(store.getStore("vieja-activa")));
  check("Una tienda en revisión nunca se borra sola", Boolean(store.getStore("vieja-revision")));
  check("Un borrador reciente se conserva", Boolean(store.getStore("nueva")));
  check("Un borrador viejo con un pedido pagado se conserva", Boolean(store.getStore("con-pago")) && !removed.includes("con-pago"));
  check("Un alta a medias de hace 20 días se limpia", !db.prepare("SELECT 1 FROM onboarding WHERE owner = 'tg-24'").get());
  check("Correr la limpieza otra vez no borra nada más", expireStaleDrafts(14).length === 0);
}
process.env.ONBOARDING_MAX_DRAFTS = "0";
check("Con el tope de borradores lleno → no se aceptan altas nuevas", /no estamos recibiendo/.test((await say("tg-5", "/vender"))!));
process.env.MERCHANT_ONBOARDING = "off";
check("Con MERCHANT_ONBOARDING=off, /vender va al agente", (await say("tg-6", "/vender")) === null);

db.close();
cleanup();
console.log(failures === 0 ? "\n✅ Todas las pruebas pasaron" : `\n❌ ${failures} prueba(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
