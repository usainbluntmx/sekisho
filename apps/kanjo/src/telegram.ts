/**
 * Canal de Telegram: un solo bot para todas las tiendas.
 * Cada tienda comparte su link t.me/<bot>?start=<tienda>; al abrirlo, Telegram manda "/start <tienda>"
 * y el cliente queda con esa tienda (mismo mecanismo que /tienda en WhatsApp).
 *
 * Los clientes de Telegram se guardan como "tg-<chat_id>": así el buzón, la memoria,
 * los pedidos y la bandeja de avisos funcionan igual que con WhatsApp.
 */
import type { Hono } from "hono";
import type { IncomingMessage } from "./whatsapp.js";
import { safeEqual } from "./security.js";

const API = "https://api.telegram.org";
const token = () => process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";

export const TELEGRAM_PATH = "/telegram/webhook";
export const TELEGRAM_PREFIX = "tg-";
/** Texto máximo que se le pasa al agente (más largo se corta). */
export const MAX_TEXT = 1000;

export function isTelegramCustomer(id: string): boolean {
  return id.startsWith(TELEGRAM_PREFIX);
}

export function telegramConfigured(): boolean {
  return /^\d+:[\w-]{30,}$/.test(token());
}

/** chat_id de Telegram a partir del id de cliente ("tg-123" → "123"). */
function chatIdOf(customerId: string): string {
  return customerId.slice(TELEGRAM_PREFIX.length);
}

/**
 * Convierte un update de Telegram en un mensaje del buzón, o null si no se atiende:
 * solo chats privados, de personas (no bots), con texto o nota de voz. Las ediciones se ignoran.
 */
export function parseTelegramUpdate(update: any): IncomingMessage | null {
  const m = update?.message;
  if (!m || typeof update.update_id !== "number") return null;
  if (m.chat?.type !== "private" || m.from?.is_bot) return null;

  const base = {
    from: `${TELEGRAM_PREFIX}${m.chat.id}`,
    name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ").slice(0, 80),
    id: `${TELEGRAM_PREFIX}u${update.update_id}`,
  };
  if (typeof m.text === "string") return { ...base, type: "text", text: m.text.slice(0, MAX_TEXT) };
  const audio = m.voice ?? m.audio;
  if (audio?.file_id) return { ...base, type: "audio", audioId: String(audio.file_id), audioMime: audio.mime_type ?? "audio/ogg" };
  return { ...base, type: m.photo ? "image" : "other" };
}

/**
 * El formato del agente es el de WhatsApp (*negritas*). Telegram con HTML es lo más seguro:
 * se escapa todo y solo se convierten las negritas. Un link con "_" o "*" nunca rompe el mensaje.
 */
export function toTelegramHtml(text: string): string {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return escaped.replace(/(^|[\s(¡¿])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, "$1<b>$2</b>");
}

async function call(method: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null;
  if (!res.ok || !json?.ok) {
    // Nunca se incluye el token en el error (la URL lo lleva)
    throw new Error(`Telegram ${method} ${res.status}: ${json?.description ?? "sin detalle"}`);
  }
  return json.result;
}

/** Envía un texto al cliente. Si el HTML no pasa, reintenta como texto plano. Lanza si falla (para reintentar). */
export async function sendTelegramText(customerId: string, text: string): Promise<void> {
  if (!telegramConfigured()) {
    console.log(`\n[telegram:dry-run → ${customerId}]\n${text}\n`);
    return;
  }
  const chat_id = chatIdOf(customerId);
  try {
    await call("sendMessage", { chat_id, text: toTelegramHtml(text), parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  } catch (error) {
    if (!/can't parse entities/i.test((error as Error).message)) throw error;
    await call("sendMessage", { chat_id, text, link_preview_options: { is_disabled: true } });
  }
}

/** Descarga una nota de voz (2 pasos: getFile → archivo). */
export async function downloadTelegramFile(fileId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  const file = (await call("getFile", { file_id: fileId })) as { file_path?: string; file_size?: number };
  if (!file.file_path) throw new Error("Telegram no devolvió el archivo");
  if ((file.file_size ?? 0) > 10 * 1024 * 1024) throw new Error("Audio demasiado grande");
  const res = await fetch(`${API}/file/bot${token()}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Telegram descarga ${res.status}`);
  return { bytes: new Uint8Array<ArrayBuffer>(await res.arrayBuffer()), mime: "audio/ogg" };
}

/** Configura el webhook y devuelve el usuario del bot (para armar los links por tienda). */
export async function setupTelegramWebhook(publicBaseUrl: string, secret: string): Promise<{ username: string; url: string }> {
  const url = `${publicBaseUrl.replace(/\/$/, "")}${TELEGRAM_PATH}`;
  await call("setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true, max_connections: 10 });
  const me = (await call("getMe", {})) as { username: string };
  return { username: me.username, url };
}

export async function telegramWebhookInfo(): Promise<{ url: string; pending_update_count: number; last_error_message?: string }> {
  return call("getWebhookInfo", {});
}

export async function telegramUsername(): Promise<string> {
  return ((await call("getMe", {})) as { username: string }).username;
}

/** Link para compartir de una tienda. */
export function storeLink(username: string, storeId: string): string {
  return `https://t.me/${username}?start=${storeId}`;
}

/**
 * Límite por persona: Telegram es abierto y gratis, así que sin esto alguien podría gastar
 * la cuenta del agente mandando mensajes sin parar. Ventana deslizante en memoria (una réplica).
 */
export function createChatLimiter({ max, windowMs }: { max: number; windowMs: number }) {
  const hits = new Map<string, number[]>();
  return {
    /** true si el mensaje pasa; false si ya superó el límite (solo el primero excedido se avisa). */
    allow(id: string, now = Date.now()): { ok: boolean; warn: boolean } {
      const recent = (hits.get(id) ?? []).filter((t) => now - t < windowMs);
      recent.push(now);
      hits.set(id, recent);
      if (hits.size > 10_000) for (const key of [...hits.keys()].slice(0, 5_000)) hits.delete(key);
      return { ok: recent.length <= max, warn: recent.length === max + 1 };
    },
  };
}

export interface TelegramWebhookOptions {
  secret: string;
  /** Guarda el mensaje en el buzón; false si es duplicado. */
  save: (msg: IncomingMessage) => boolean;
  /** Procesa un mensaje ya guardado (en segundo plano). */
  process: (msg: IncomingMessage) => void;
  /** Un mensaje guardado que no se atiende por el límite: se cierra en el buzón para que no se recupere al reiniciar. */
  discard?: (msg: IncomingMessage) => void;
  /** Aviso a quien excedió el límite. */
  notifyLimited?: (customerId: string) => void;
  /** Mensajes que no cuentan para el límite (no llaman al agente): administrador, alta de comerciantes. */
  exempt?: (msg: IncomingMessage) => boolean;
  perUser?: { max: number; windowMs: number };
}

/**
 * Webhook de Telegram. Responde 200 rápido (Telegram reintenta si tarda o falla) y procesa en segundo plano.
 * Sin el header secreto correcto, 401: solo Telegram conoce el secreto que se le dio en setWebhook.
 */
export function registerTelegramWebhook(app: Hono, options: TelegramWebhookOptions): void {
  const limiter = createChatLimiter(options.perUser ?? { max: 20, windowMs: 10 * 60_000 });
  app.post(TELEGRAM_PATH, async (c) => {
    const header = c.req.header("x-telegram-bot-api-secret-token") ?? "";
    if (!options.secret || !safeEqual(header, options.secret)) return c.text("Forbidden", 401);

    const update = await c.req.json().catch(() => null);
    const msg = parseTelegramUpdate(update);
    if (!msg) return c.text("OK", 200); // grupos, bots, ediciones, stickers…: se ignoran sin reintentos

    // Primero el duplicado (Telegram reintenta si tardamos): un reintento no cuenta para el límite
    if (!options.save(msg)) return c.text("OK", 200);
    const limit = options.exempt?.(msg) ? { ok: true, warn: false } : limiter.allow(msg.from);
    if (!limit.ok) {
      options.discard?.(msg);
      if (limit.warn) options.notifyLimited?.(msg.from);
      return c.text("OK", 200);
    }
    console.log(`[telegram] ${msg.name} (${msg.from}): ${msg.text ?? `[${msg.type}]`}`);
    options.process(msg);
    return c.text("OK", 200);
  });
}
