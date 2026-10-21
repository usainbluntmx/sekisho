import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { isValidSignature, parseIncomingMessages, sendText } from "./whatsapp.js";
import { handleMessage } from "./bot.js";
import { registerCheckout } from "./checkout.js";

const PORT = Number(process.env.PORT ?? 3000);
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
const DEV_CHAT_TOKEN = process.env.DEV_CHAT_TOKEN ?? "";

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

// Chat de prueba por HTTP (solo si DEV_CHAT_TOKEN está definido)
if (DEV_CHAT_TOKEN) {
  app.post("/dev/chat", async (c) => {
    if (c.req.header("x-dev-token") !== DEV_CHAT_TOKEN) return c.text("Forbidden", 403);

    const body = await c.req.json<{ from?: string; name?: string; text?: string }>();
    if (!body.text) return c.json({ error: "Falta el campo text" }, 400);

    const replies: string[] = [];
    await handleMessage(
      { from: body.from ?? "5215500000000", name: body.name ?? "Tester", type: "text", text: body.text },
      async (_to, reply) => {
        replies.push(reply);
      }
    );
    return c.json({ replies });
  });
  console.log("[kanjo] /dev/chat habilitado");
}

serve({ fetch: app.fetch, port: PORT });
console.log(`[kanjo] Servidor en http://localhost:${PORT}`);