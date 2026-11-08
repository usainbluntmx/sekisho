import { rmSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";

// Base temporal y un token de bot falso: ninguna llamada sale a Telegram (fetch simulado)
const TEST_DB = "data/test-telegram.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(TEST_DB + suffix, { force: true });
};
cleanup();
process.env.DB_PATH = TEST_DB;
process.env.OPERATOR_PRIVATE_KEY ??= generatePrivateKey();
const FAKE_TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;

const { db } = await import("../db.js");
const store = await import("../store.js");
const tg = await import("../telegram.js");
const { saveIncoming, markDone, recoverPendingMessages } = await import("../inbox.js");
const { defaultDeliver } = await import("../outbox.js");
const { enqueueOrderPaid } = await import("../notify.js");
const { handleMessage } = await import("../bot.js");
const { Hono } = await import("hono");

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}

// fetch simulado: registra cada llamada a la API de Telegram y responde ok (o el error que se le pida)
const calls: { method: string; body: any }[] = [];
let failNext: string | null = null;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop()!;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ method, body });
  if (failNext) {
    const description = failNext;
    failNext = null;
    return new Response(JSON.stringify({ ok: false, description }), { status: 400 });
  }
  return new Response(JSON.stringify({ ok: true, result: { username: "kanjo_test_bot", message_id: 1 } }), { status: 200 });
}) as typeof fetch;

const update = (id: number, message: Record<string, unknown>) => ({
  update_id: id,
  message: { message_id: id, chat: { id: 555, type: "private" }, from: { id: 555, first_name: "Ana", last_name: "López", is_bot: false }, ...message },
});

console.log("─── Mensajes entrantes ───");
const text = tg.parseTelegramUpdate(update(1, { text: "hola" }));
check("Texto en chat privado → cliente tg-555 con nombre", text?.from === "tg-555" && text.name === "Ana López" && text.text === "hola" && text.id === "tg-u1");
const voice = tg.parseTelegramUpdate(update(2, { voice: { file_id: "F1", mime_type: "audio/ogg" } }));
check("Nota de voz → audio con su file_id", voice?.type === "audio" && voice.audioId === "F1" && voice.text === undefined);
check("Grupos → se ignoran", tg.parseTelegramUpdate({ update_id: 3, message: { chat: { id: -1, type: "group" }, from: { is_bot: false }, text: "x" } }) === null);
check("Mensajes de bots → se ignoran", tg.parseTelegramUpdate(update(4, { from: { id: 9, is_bot: true }, text: "x" })) === null);
check("Mensajes editados → se ignoran", tg.parseTelegramUpdate({ update_id: 5, edited_message: { chat: { type: "private" } } }) === null);
check("Texto muy largo → se corta a 1000 caracteres", tg.parseTelegramUpdate(update(6, { text: "a".repeat(5000) }))?.text?.length === 1000);

console.log("─── Formato ───");
check("*Negritas* de WhatsApp → <b> de Telegram", tg.toTelegramHtml("*Total:* 5.21 USDC") === "<b>Total:</b> 5.21 USDC");
check("HTML del texto se escapa (no se puede inyectar)", tg.toTelegramHtml("<b>hola</b> & más") === "&lt;b&gt;hola&lt;/b&gt; &amp; más");
const link = "https://kanjo.zerotwolabs.xyz/pay/AB12?t=a_b*c-d*e";
check("Un link con _ y * queda intacto", tg.toTelegramHtml(`Paga aquí: ${link}`) === `Paga aquí: ${link}`);

console.log("─── Envío ───");
calls.length = 0;
await tg.sendTelegramText("tg-555", "*Hola*");
check("Envía al chat_id correcto, en HTML y sin vista previa", calls[0]?.method === "sendMessage" && calls[0].body.chat_id === "555" && calls[0].body.parse_mode === "HTML" && calls[0].body.text === "<b>Hola</b>");
calls.length = 0;
failNext = "Bad Request: can't parse entities";
await tg.sendTelegramText("tg-555", "*raro");
check("Si el HTML falla, reintenta como texto plano", calls.length === 2 && calls[1].body.parse_mode === undefined && calls[1].body.text === "*raro");
failNext = "Forbidden: bot was blocked by the user";
const blocked = await tg.sendTelegramText("tg-555", "hola").then(() => "", (e: Error) => e.message);
check("Otro error → lanza (la bandeja reintenta) y nunca incluye el token", /blocked/.test(blocked) && !blocked.includes(FAKE_TOKEN));
calls.length = 0;
await defaultDeliver("tg-555", "Pedido pagado");
check("La bandeja de avisos manda a tg-… por Telegram", calls[0]?.method === "sendMessage" && calls[0].body.chat_id === "555");

console.log("─── Webhook ───");
const SECRET = "s".repeat(40);
const processed: string[] = [];
const limited: string[] = [];
const app = new Hono();
tg.registerTelegramWebhook(app, {
  secret: SECRET,
  save: saveIncoming,
  process: (m) => {
    processed.push(m.id);
    markDone(m.id);
  },
  discard: (m) => markDone(m.id),
  notifyLimited: (to) => limited.push(to),
  perUser: { max: 3, windowMs: 60_000 },
});
const post = (body: unknown, secret?: string) =>
  app.request(tg.TELEGRAM_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) },
    body: JSON.stringify(body),
  });
check("Sin el secreto → 401 y no se procesa", (await post(update(10, { text: "x" }))).status === 401 && processed.length === 0);
check("Secreto incorrecto → 401", (await post(update(10, { text: "x" }), "t".repeat(40))).status === 401 && processed.length === 0);
check("Con el secreto → 200 y se procesa", (await post(update(10, { text: "x" }), SECRET)).status === 200 && processed.join() === "tg-u10");
check("El mismo update otra vez (reintento de Telegram) → no se procesa dos veces", (await post(update(10, { text: "x" }), SECRET)).status === 200 && processed.length === 1);
check("Un grupo → 200 sin procesar (Telegram no reintenta)", (await post({ update_id: 11, message: { chat: { id: -5, type: "group" }, from: {}, text: "x" } }, SECRET)).status === 200 && processed.length === 1);
for (const id of [12, 13, 14, 15]) await post(update(id, { text: "spam" }), SECRET);
check("Límite por persona: pasan 3 mensajes (contando el primero) y el resto no llega al agente", processed.length === 3);
check("…y se le avisa una sola vez", limited.join() === "tg-555");
check("Lo descartado por el límite no se recupera al reiniciar", recoverPendingMessages().length === 0);

console.log("─── Tiendas por link ───");
db.prepare("INSERT INTO stores (id, name, merchant_address) VALUES ('cafe-kanjo', 'Café Kanjō', '0x0000000000000000000000000000000000000001')").run();
db.prepare("INSERT INTO stores (id, name, merchant_address) VALUES ('don-pepe', 'Carnicería Don Pepe', '0x0000000000000000000000000000000000000002')").run();
const said: string[] = [];
const reply = async (_to: string, t: string) => {
  said.push(t);
};
check("El link de cada tienda", tg.storeLink("kanjo_test_bot", "don-pepe") === "https://t.me/kanjo_test_bot?start=don-pepe");
await handleMessage({ from: "tg-777", name: "Luis", type: "text", text: "/start don-pepe" }, reply);
check("/start <tienda> (abrir el link) → queda con esa tienda", store.getCustomerStore("tg-777")?.id === "don-pepe" && /Carnicería Don Pepe/.test(said.at(-1)!));
await handleMessage({ from: "tg-777", name: "Luis", type: "text", text: "/start" }, reply);
check("/start solo → saluda con su tienda actual, sin llamar al agente", /Estás con \*Carnicería Don Pepe\*/.test(said.at(-1)!));

console.log("─── Avisos al cliente de Telegram ───");
const product = Number(db.prepare("INSERT INTO products (store_id, name, price_atomic, stock) VALUES ('don-pepe', 'Chorizo', 1000000, 5)").run().lastInsertRowid);
const order = store.createOrder("don-pepe", "tg-777", [{ productId: product, quantity: 1 }]);
store.markOrderPaid(order.order.id, "0xabc");
enqueueOrderPaid(order.order.id);
const queued = db.prepare("SELECT recipient FROM outbox WHERE dedupe_key = ?").get(`order-paid:${order.order.id}:customer`) as { recipient: string } | undefined;
check("Al pagar, el cliente de Telegram recibe su aviso (tg-777)", queued?.recipient === "tg-777");

db.close();
cleanup();
console.log(failures === 0 ? "\n✅ Todas las pruebas pasaron" : `\n❌ ${failures} prueba(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
