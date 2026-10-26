import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/** Comparación en tiempo constante (no filtra secretos por diferencias de tiempo). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** IP del cliente. Cloudflare Tunnel envía la IP real en CF-Connecting-IP. */
export function clientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local"
  );
}

export interface RateLimitOptions {
  /** Peticiones permitidas por ventana. */
  max: number;
  /** Duración de la ventana en milisegundos. */
  windowMs: number;
}

/** Límite de peticiones por IP (ventana fija, en memoria: Kanjō corre en una instancia). */
export function rateLimit({ max, windowMs }: RateLimitOptions): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs).unref();

  return async (c, next) => {
    const now = Date.now();
    const key = clientIp(c);

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;
    if (entry.count > max) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: "Demasiadas solicitudes. Intenta de nuevo en un momento." }, 429);
    }

    await next();
  };
}

/** Tamaño máximo de body: ningún endpoint de Kanjō necesita más (los webhooks de Meta pesan pocos KB). */
export const MAX_BODY_BYTES = 64 * 1024;

/** Rechaza con 413 cualquier body mayor a MAX_BODY_BYTES, antes de parsearlo o validarlo. */
export const limitBody: MiddlewareHandler = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.text("Payload too large", 413),
});