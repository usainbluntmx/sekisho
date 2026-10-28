import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { handleMessage } from "./bot.js";
import { enqueue } from "./inbox.js";
import { rateLimit } from "./security.js";
import { getStore, listProducts } from "./store.js";
import { elevenLabsConfigured, synthesizeVoice, transcribeAudio } from "./voice.js";
import { spokenText } from "./voice-text.js";
import { renderVoicePage } from "./web/voice-page.js";

/** Ruta del API de voz web: index.ts la exime del límite global de 64 KB (lleva el suyo). */
export const VOICE_API_PATH = "/voice/api";
const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // ~1 min de voz en webm/opus
const SESSION_RE = /^[a-z0-9]{8,32}$/;

export function voiceWebEnabled(): boolean {
  return process.env.VOICE_WEB === "on";
}

/**
 * Canal de voz web: el cliente habla desde el navegador y Kanjō contesta en voz y en texto.
 * Usa el mismo agente, catálogo y checkout que WhatsApp; no depende de Meta.
 */
export function registerVoiceWeb(app: Hono): void {
  if (!voiceWebEnabled()) return;
  const storeId = process.env.STORE_ID ?? "cafe-kanjo";

  app.use(VOICE_API_PATH, rateLimit({ max: Number(process.env.VOICE_WEB_PER_MINUTE ?? 12), windowMs: 60_000 }));

  app.get("/voice", (c) => {
    const store = getStore(storeId);
    if (!store) return c.text("La tienda aún no está configurada", 503);
    return c.html(renderVoicePage({ store, products: listProducts(storeId), voice: elevenLabsConfigured() }));
  });

  app.post(
    VOICE_API_PATH,
    bodyLimit({ maxSize: MAX_AUDIO_BYTES + 64 * 1024, onError: (c) => c.json({ error: "El audio es demasiado largo" }, 413) }),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      if (!form) return c.json({ error: "Formato inválido" }, 400);

      const session = String(form.get("session") ?? "");
      if (!SESSION_RE.test(session)) return c.json({ error: "Sesión inválida" }, 400);
      const wantVoice = form.get("voice") !== "0";
      const audio = form.get("audio");
      let text = typeof form.get("text") === "string" ? String(form.get("text")).trim().slice(0, 1000) : "";

      let transcript: string | null = null;
      if (audio instanceof File && audio.size > 0) {
        if (!elevenLabsConfigured()) return c.json({ error: "La voz no está configurada en este servidor" }, 503);
        if (audio.size > MAX_AUDIO_BYTES) return c.json({ error: "El audio es demasiado largo" }, 413);
        try {
          transcript = await transcribeAudio(new Uint8Array(await audio.arrayBuffer()), audio.type);
        } catch (error) {
          console.error("[voice-web] Falló la transcripción:", (error as Error).message);
          return c.json({ error: "No pude transcribir el audio. Intenta de nuevo." }, 502);
        }
        if (!transcript) return c.json({ error: "No alcancé a escucharte. ¿Lo repites?" }, 422);
        text = transcript;
      }
      if (!text) return c.json({ error: "Habla o escribe algo" }, 400);

      const from = `web-${session}`;
      const replies: string[] = [];
      await enqueue(from, () =>
        handleMessage({ from, name: "Cliente web", type: transcript ? "audio" : "text", text }, async (_to, reply) => {
          replies.push(reply);
        })
      );

      // Voz: se lee la respuesta sin links (el link se muestra en pantalla). Si falla, queda el texto.
      const voiced = await Promise.all(
        replies.map(async (reply) => {
          if (!wantVoice || !elevenLabsConfigured()) return { text: reply, audio: null };
          const spoken = spokenText(reply);
          if (!spoken) return { text: reply, audio: null };
          try {
            const bytes = await synthesizeVoice(spoken, "mp3_44100_64");
            return { text: reply, audio: `data:audio/mpeg;base64,${Buffer.from(bytes).toString("base64")}` };
          } catch (error) {
            console.warn("[voice-web] Falló la voz, se responde solo texto:", (error as Error).message);
            return { text: reply, audio: null };
          }
        })
      );

      console.log(`[voice-web] ${from}: "${text.slice(0, 60)}" → ${replies.length} respuesta(s)`);
      return c.json({ transcript, replies: voiced });
    }
  );

  console.log("[kanjo] Canal de voz web habilitado en /voice");
}
