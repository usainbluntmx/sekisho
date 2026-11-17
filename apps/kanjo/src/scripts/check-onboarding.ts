import { rmSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

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
const wl = await import("../wallet-link.js");
const { registerWalletRoutes } = await import("../wallet-routes.js");
const { tryStartSettlement, endSettlement } = await import("../settlement-guard.js");
const { Hono } = await import("hono");

// Página de firma montada como en producción; las wallets de contrato se consultan a la red: aquí no
wl.setContractSignatureCheck(async () => false);
const web = new Hono();
registerWalletRoutes(web);
const tokenIn = (text: string | null) => text?.match(/\/wallet\/([A-Za-z0-9_-]+)/)?.[1] ?? "";
const sign = async (account: ReturnType<typeof privateKeyToAccount>, token: string, claimed = account.address) => {
  const link = wl.getWalletLink(token)!;
  const signature = await account.signMessage({ message: wl.walletMessage(link) });
  const res = await web.request(`/api/wallet/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: claimed, signature }),
  });
  return { status: res.status, body: (await res.json()) as { ok?: boolean; message?: string; error?: string } };
};
const pepeWallet = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

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
console.log("─── Wallet con firma (ARCH-010) ───");
const walletReply = (await say(PEPE, "20"))!;
const firstToken = tokenIn(walletReply);
check("Tiempo → manda un link para firmar con la wallet, y avisa de los exchanges", Boolean(firstToken) && /firma/.test(walletReply) && /exchange/.test(walletReply));
check("Pegar la dirección ya no sirve: pide firmar desde el link", /Ya no hace falta pegar/.test((await say(PEPE, pepeWallet.address))!));
const token = tokenIn(await say(PEPE, "/wallet"));
check("/wallet manda un link nuevo y el anterior deja de servir", Boolean(token) && token !== firstToken && wl.getWalletLink(firstToken) === undefined);
const page = await web.request(`/wallet/${token}`);
const pageHtml = await page.text();
const encoded = pageHtml.match(/data-message="([^"]+)"/)?.[1] ?? "";
check("La página de firma muestra el mensaje con la tienda y el código", page.status === 200 && pageHtml.includes("Carnicería Don Pepe") && pageHtml.includes(token) && pageHtml.includes("/public/wallet.js"));
check("…y el mensaje que firma el navegador es idéntico al que verifica el servidor", decodeURIComponent(encoded) === wl.walletMessage(wl.getWalletLink(token)!));
check("Un link que no existe → 404", (await web.request("/wallet/AAAAAAAAAAAAAAAAAAAAAA")).status === 404);
const forged = await sign(stranger, token, pepeWallet.address);
check("Firma de otra wallet para la dirección de Pepe → rechazada", forged.status === 400 && /no corresponde/.test(forged.body.error ?? ""));
check("…y el alta sigue esperando la wallet", /firma/.test((await say(PEPE, "hola"))!));
const signed = await sign(pepeWallet, token);
check("Firma correcta → wallet verificada", signed.status === 200 && /verificada/.test(signed.body.message ?? ""));
check("…y el chat pasa a los productos con ejemplos de su giro", /Wallet verificada[\s\S]*Arrachera, 380, kg, 10/.test(outbox(`wallet-ok:${token}`)?.body ?? "") && outbox(`wallet-ok:${token}`)?.recipient === PEPE);
check("El mismo link no se puede usar dos veces", (await sign(pepeWallet, token)).status === 409);
{
  // Wallet de contrato (Safe, ERC-1271): la firma no es de una llave, se valida con la red
  const safe = "0x000000000000000000000000000000000000dEaD";
  wl.setContractSignatureCheck(async (address) => address === safe);
  const link = wl.createWalletLink("tg-78", "Tienda con Safe");
  const res = await web.request(`/api/wallet/${link.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: safe, signature: "0x1234" }) });
  check("Wallet de contrato (ERC-1271): la firma se valida con la red y se acepta", wl.getWalletLink(link.token)?.address?.toLowerCase() === safe.toLowerCase() && res.status === 409);
  wl.setContractSignatureCheck(async () => false);
}
const late = wl.createWalletLink("tg-77", "Tienda tardía");
db.prepare("UPDATE wallet_links SET expires_at = datetime('now', '-1 minutes') WHERE token = ?").run(late.token);
check("Un link vencido → 410 y pide otro", (await sign(pepeWallet, late.token)).status === 410 && (await web.request(`/wallet/${late.token}`)).status === 410);
check("Lista con errores → no guarda y explica", /no guardé nada[\s\S]*falta el precio/.test((await say(PEPE, "Arrachera, 380, kg, 10\nChorizo"))!));
const preview = (await say(PEPE, "Arrachera, 380, kg, 10\nChorizo, 160, kg"))!;
check("Lista válida → vista previa en USDC con el precio en pesos de vuelta", /Arrachera — 20.54 USDC \/ kg \(≈380 MXN\) · hay 10 kg/.test(preview) && store.getStoreByOwner(PEPE) === undefined);
check("«sí» → crea el borrador", /quedó como borrador/.test((await say(PEPE, "sí"))!));
const draft = pepeStore();
check("Borrador con su dueño, contacto, wallet firmada, perfil y 2 productos por kilo", draft.status === "draft" && draft.owner === PEPE && draft.contact === PEPE && draft.merchant_address === pepeWallet.address && wl.walletVerifiedAt(draft.id) !== null && draft.profile.address === "Av. Juárez 123, Centro" && draft.profile.prepMinutes === 20 && store.listProducts(draft.id).length === 2 && store.listProducts(draft.id)[0].unit === "kg");
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
check("Al administrador le llega el resumen con wallet, productos y /aprobar", review?.recipient === ADMIN && review.body.includes(`${pepeWallet.address} (✅ firmada)`) && /Arrachera/.test(review.body) && review.body.includes(`/aprobar ${draft.id}`));
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
for (const answer of ["Abarrotes Lupita", "2", "1", "Calle 5 número 10", "saltar"]) await say(tryOwner, answer);
await sign(privateKeyToAccount(generatePrivateKey()), tokenIn(await say(tryOwner, "saltar")));
for (const answer of ["Leche 1 L, 28, 10", "sí"]) await say(tryOwner, answer);
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
console.log("─── Cambio de wallet ───");
{
  const splits: string[] = [];
  let pendingOld = 2_000_000n;
  let failSplit = false;
  wl.setWalletChain({
    pendingAtomic: async () => pendingOld,
    distribute: async (merchant) => {
      if (failSplit) throw new Error("RPC caída");
      splits.push(merchant);
      return "0xsplit";
    },
  });
  const ADMIN_SAY = (text: string) => say(ADMIN, text);
  const pepeId = pepeStore().id;
  const oldWallet = pepeStore().merchant_address;
  const newWallet = privateKeyToAccount(generatePrivateKey());

  await say(PEPE, "/vender");
  check("El panel muestra la wallet firmada", /Wallet: 0x\w{4}…\w{4} ✅ firmada/.test((await say(PEPE, "/vender"))!));
  const changeReply = (await say(PEPE, "/wallet"))!;
  const t1 = tokenIn(changeReply);
  check("/wallet en una tienda publicada → link y aviso de revisión", Boolean(t1) && /revisamos antes de aplicarlo/.test(changeReply));
  const sent = await sign(newWallet, t1);
  check("Firma de la wallet nueva → queda en revisión, sin cambiar todavía", sent.status === 200 && pepeStore().merchant_address === oldWallet);
  check("Al administrador le llega la actual, la nueva y /aprobarwallet", /Actual: 0x[\s\S]*Nueva \(firmada\)[\s\S]*\/aprobarwallet carniceria-don-pepe/.test(outbox(`wallet-review:${t1}`)?.body ?? ""));
  check("/pendientes lista el cambio de wallet", /aprobarwallet carniceria-don-pepe/.test((await ADMIN_SAY("/pendientes"))!));
  check("Un cliente que escribe /aprobarwallet no cambia nada", (await say(CLIENTE, `/aprobarwallet ${pepeId}`)) === null && pepeStore().merchant_address === oldWallet);

  failSplit = true;
  check("Si el reparto del vault anterior falla → no se cambia nada", /No se aplicó/.test((await ADMIN_SAY(`/aprobarwallet ${pepeId}`))!) && pepeStore().merchant_address === oldWallet);
  failSplit = false;

  const approved = (await ADMIN_SAY(`/aprobarwallet ${pepeId}`))!;
  check("/aprobarwallet → primero reparte lo pendiente a la wallet anterior", splits.join() === oldWallet && /Reparto previo del vault anterior: 0xsplit/.test(approved));
  check("…y luego la tienda cobra en la wallet nueva, firmada", pepeStore().merchant_address === newWallet.address && wl.walletVerifiedAt(pepeId) !== null);
  check("…queda en el historial y el repartidor sigue revisando la anterior", wl.recentPreviousWallets().some((w) => w.storeId === pepeId && w.address === oldWallet));
  check("…y el comerciante recibe el aviso", /ahora llegan a/.test(outbox(`wallet-changed:${pepeId}`)?.body ?? ""));

  const t2 = tokenIn(await say(PEPE, "/wallet"));
  const same = await sign(newWallet, t2);
  check("Firmar con la misma wallet → solo queda firmada (sin revisión ni reparto)", same.status === 200 && /quedó firmada/.test(same.body.message ?? "") && splits.length === 1);

  const t3 = tokenIn(await say(PEPE, "/wallet"));
  await sign(privateKeyToAccount(generatePrivateKey()), t3);
  check("/rechazarwallet → no cambia y avisa al comerciante", /rechazado/.test((await ADMIN_SAY(`/rechazarwallet ${pepeId} no reconozco esa wallet`))!) && pepeStore().merchant_address === newWallet.address && /no reconozco esa wallet/.test(outbox(`wallet-rejected:${t3}`)?.body ?? ""));

  // Borrador: el cambio se aplica al firmar, sin revisión; con un cobro en curso, no
  const OWNER = "tg-31";
  const owner = privateKeyToAccount(generatePrivateKey());
  store.createStore({ id: "borrador-wallet", name: "Borrador wallet", merchant: WALLET, status: "draft", owner: OWNER });
  const productId = Number(db.prepare("INSERT INTO products (store_id, name, price_atomic, stock) VALUES ('borrador-wallet', 'x', 1000000, 5)").run().lastInsertRowid);
  store.upsertCustomer(OWNER, "Dueña");
  const inFlight = store.createOrder("borrador-wallet", OWNER, [{ productId, quantity: 1 }]).order;
  await say(OWNER, "/vender");
  const t4 = tokenIn(await say(OWNER, "/wallet"));
  tryStartSettlement(inFlight.id);
  const busy = await sign(owner, t4);
  endSettlement(inFlight.id);
  check("Con un cobro en curso → no cambia la wallet", busy.status === 409 && /pago en curso/.test(busy.body.error ?? "") && store.getStore("borrador-wallet")!.merchant_address === WALLET);
  pendingOld = 0n;
  const t5 = tokenIn(await say(OWNER, "/wallet"));
  const draftChange = await sign(owner, t5);
  check("Borrador: el cambio se aplica al firmar, sin revisión y sin reparto si no hay pendiente", draftChange.status === 200 && store.getStore("borrador-wallet")!.merchant_address === owner.address && splits.length === 1 && !outbox(`wallet-review:${t5}`));
}

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
