import "./env.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { isValidSignature, parseIncomingMessages, sendText } from "./whatsapp.js";
import { handleMessage } from "./bot.js";
import { registerCheckout } from "./checkout.js";
import { claimMessage, enqueue, pruneProcessedMessages } from "./inbox.js";
import { startDistributionScheduler } from "./distributor.js";
import { startOutboxWorker } from "./outbox.js";
import { recoverPaidNotifications } from "./notify.js";
import { rateLimit, safeEqual } from "./security.js";

const PORT = Number(process.env.PORT ?? 3000);
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
const DEV_CHAT_TOKEN = process.env.DEV_CHAT_TOKEN ?? "";

const app = new Hono();

app.get("/", (c) => c.json({ service: "Kanjō", status: "ok" }));

// Archivos estáticos (bundle del checkout)
app.use("/public/*", serveStatic({ root: "./" }));

// Límites por IP (se registran antes que las rutas que protegen)
app.use("/pay/*", rateLimit({ max: 60, windowMs: 60_000 }));
app.use("/api/pay", rateLimit({ max: 30, windowMs: 60_000 }));
app.use("/dev/chat", rateLimit({ max: 20, windowMs: 60_000 }));

// Checkout web + cobro x402
registerCheckout(app);

// Verificación del webhook (Meta envía un GET al guardar la URL)
app.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && VERIFY_TOKEN && token && safeEqual(token, VERIFY_TOKEN) && challenge) {
    console.log("[webhook] Verificado por Meta");
    return c.text(challenge, 200);
  }
  return c.text("Forbidden", 403);
});

// Mensajes entrantes de WhatsApp: responder 200 de inmediato y procesar en segundo plano
app.post("/webhook", async (c) => {
  const rawBody = await c.req.text();

  if (!isValidSignature(rawBody, c.req.header("x-hub-signature-256"))) {
    console.warn("[webhook] Firma inválida, ignorado");
    return c.text("Invalid signature", 401);
  }

  let messages: ReturnType<typeof parseIncomingMessages>;
  try {
    messages = parseIncomingMessages(JSON.parse(rawBody));
  } catch {
    return c.text("Bad Request", 400);
  }

  for (const msg of messages) {
    if (!claimMessage(msg.id)) {
      console.log(`[webhook] Duplicado ignorado: ${msg.id}`);
      continue;
    }

    console.log(`[webhook] ${msg.name} (${msg.from}): ${msg.text ?? `[${msg.type}]`}`);
    void enqueue(msg.from, () => handleMessage(msg, sendText)).catch((error) =>
      console.error(`[webhook] Error procesando ${msg.id}:`, error)
    );
  }

  return c.text("OK", 200);
});

// Chat de prueba por HTTP (solo si DEV_CHAT_TOKEN está definido)
if (DEV_CHAT_TOKEN) {
  app.post("/dev/chat", async (c) => {
    if (!safeEqual(c.req.header("x-dev-token") ?? "", DEV_CHAT_TOKEN)) return c.text("Forbidden", 403);

    const body = await c.req.json<{ from?: string; name?: string; text?: string }>();
    if (!body.text) return c.json({ error: "Falta el campo text" }, 400);

    const from = body.from ?? "5215500000000";
    const replies: string[] = [];

    // Misma cola por cliente que el webhook: mensajes en orden
    await enqueue(from, () =>
      handleMessage(
        { from, name: body.name ?? "Tester", type: "text", text: body.text },
        async (_to, reply) => {
          replies.push(reply);
        }
      )
    );
    return c.json({ replies });
  });
  console.log("[kanjo] /dev/chat habilitado");
}

// Limpieza diaria de ids de mensajes procesados
pruneProcessedMessages();
setInterval(() => pruneProcessedMessages(), 24 * 60 * 60 * 1000).unref();

// Avisos: recuperar los que no alcanzaron a encolarse y arrancar la bandeja de salida
const recovered = recoverPaidNotifications();
if (recovered > 0) console.log(`[outbox] ${recovered} aviso(s) recuperado(s) de pedidos pagados recientes`);
startOutboxWorker();

// Reparto por lotes de los vaults
startDistributionScheduler();

serve({ fetch: app.fetch, port: PORT });
console.log(`[kanjo] Servidor en http://localhost:${PORT}`);