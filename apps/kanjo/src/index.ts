import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { isValidSignature, parseIncomingMessages, sendText } from "./whatsapp.js";
import { handleMessage } from "./bot.js";
import { registerCheckout } from "./checkout.js";

const PORT = Number(process.env.PORT ?? 3000);
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? "";

const app = new Hono();

app.get("/", (c) => c.json({ service: "Kanjō", status: "ok" }));

// Archivos estáticos (bundle del checkout)
app.use("/public/*", serveStatic({ root: "./" }));

// Checkout web + cobro x402
registerCheckout(app);

// Verificación del webhook (Meta envía un GET al guardar la URL)
app.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
    console.log("[webhook] Verificado por Meta");
    return c.text(challenge, 200);
  }
  return c.text("Forbidden", 403);
});

// Mensajes entrantes de WhatsApp
app.post("/webhook", async (c) => {
  const rawBody = await c.req.text();

  if (!isValidSignature(rawBody, c.req.header("x-hub-signature-256"))) {
    console.warn("[webhook] Firma inválida, ignorado");
    return c.text("Invalid signature", 401);
  }

  for (const msg of parseIncomingMessages(JSON.parse(rawBody))) {
    console.log(`[webhook] ${msg.name} (${msg.from}): ${msg.text ?? `[${msg.type}]`}`);
    await handleMessage(msg, sendText);
  }

  return c.text("OK", 200);
});

serve({ fetch: app.fetch, port: PORT });
console.log(`[kanjo] Servidor en http://localhost:${PORT}`);