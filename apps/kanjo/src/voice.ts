/**
 * Voz con ElevenLabs: audio → texto (Scribe) y texto → audio (TTS).
 * Más la entrega por WhatsApp: descargar el audio del cliente y mandar notas de voz.
 */

const ELEVEN = "https://api.elevenlabs.io/v1";
const GRAPH = "https://graph.facebook.com";

const env = (name: string, fallback = "") => process.env[name] ?? fallback;

/** Hay llave y voz configuradas (requisito de cualquier canal de voz). */
export function elevenLabsConfigured(): boolean {
  return !!env("ELEVENLABS_API_KEY") && !!env("ELEVENLABS_VOICE_ID");
}

/** Notas de voz por WhatsApp: encendidas, con ElevenLabs y con credenciales de Meta. */
export function whatsappVoiceEnabled(): boolean {
  return env("VOICE_REPLIES") === "on" && elevenLabsConfigured() && !!env("WHATSAPP_TOKEN") && !!env("WHATSAPP_PHONE_NUMBER_ID");
}

function extensionFor(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "bin";
}

/** Audio → texto en español. Devuelve null si no se entendió nada. */
export async function transcribeAudio(bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<string | null> {
  const key = env("ELEVENLABS_API_KEY");
  if (!key) throw new Error("ELEVENLABS_API_KEY no está configurada");

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime || "application/octet-stream" }), `audio.${extensionFor(mime)}`);
  form.append("model_id", env("ELEVENLABS_STT_MODEL", "scribe_v2"));
  form.append("language_code", env("VOICE_LANGUAGE", "es"));
  form.append("tag_audio_events", "false");

  const started = Date.now();
  const res = await fetch(`${ELEVEN}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { text?: string };
  const text = data.text?.trim() || null;
  console.log(`[voice] STT ${Date.now() - started} ms: "${(text ?? "").slice(0, 80)}"`);
  return text;
}

/** Formatos de salida: mp3 para el navegador, Ogg/Opus mono para notas de voz de WhatsApp. */
export type VoiceFormat = "mp3_44100_64" | "mp3_44100_128" | "opus_48000_32";

/** Texto → audio con la voz configurada. */
export async function synthesizeVoice(text: string, format: VoiceFormat): Promise<Uint8Array<ArrayBuffer>> {
  const key = env("ELEVENLABS_API_KEY");
  const voiceId = env("ELEVENLABS_VOICE_ID");
  if (!key || !voiceId) throw new Error("ELEVENLABS_API_KEY o ELEVENLABS_VOICE_ID no están configuradas");

  const started = Date.now();
  const res = await fetch(`${ELEVEN}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${format}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/*" },
    body: JSON.stringify({ text, model_id: env("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2") }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const bytes = new Uint8Array<ArrayBuffer>(await res.arrayBuffer());
  console.log(`[voice] TTS ${Date.now() - started} ms · ${bytes.length} bytes (${format})`);
  return bytes;
}

// ─────────────── WhatsApp ───────────────

const graphVersion = () => env("GRAPH_API_VERSION", "v23.0");

/** Descarga el audio del cliente desde Meta (2 pasos: metadata → binario). */
export async function downloadWhatsAppMedia(mediaId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  const token = env("WHATSAPP_TOKEN");
  const metaRes = await fetch(`${GRAPH}/${graphVersion()}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!metaRes.ok) throw new Error(`Meta media ${metaRes.status}: ${(await metaRes.text()).slice(0, 300)}`);
  const meta = (await metaRes.json()) as { url: string; mime_type: string };

  const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!binRes.ok) throw new Error(`Meta download ${binRes.status}`);
  return { bytes: new Uint8Array<ArrayBuffer>(await binRes.arrayBuffer()), mime: meta.mime_type };
}

/** Nota de voz por WhatsApp: TTS en Ogg/Opus → subir a Meta → mandar con voice: true. */
export async function sendWhatsAppVoiceNote(to: string, text: string): Promise<void> {
  const token = env("WHATSAPP_TOKEN");
  const phoneId = env("WHATSAPP_PHONE_NUMBER_ID");
  const bytes = await synthesizeVoice(text, "opus_48000_32");
  if (bytes.length > 512 * 1024) {
    // Meta solo muestra el botón de reproducir en notas de voz de hasta 512 KB
    throw new Error(`Nota de voz de ${bytes.length} bytes (> 512 KB)`);
  }

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "audio/ogg");
  form.append("file", new Blob([bytes], { type: "audio/ogg" }), "kanjo.ogg");
  const upRes = await fetch(`${GRAPH}/${graphVersion()}/${phoneId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!upRes.ok) throw new Error(`Meta upload ${upRes.status}: ${(await upRes.text()).slice(0, 300)}`);
  const { id } = (await upRes.json()) as { id: string };

  const { normalizeRecipient } = await import("./whatsapp.js");
  const sendRes = await fetch(`${GRAPH}/${graphVersion()}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizeRecipient(to),
      type: "audio",
      audio: { id, voice: true },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!sendRes.ok) throw new Error(`Meta audio ${sendRes.status}: ${(await sendRes.text()).slice(0, 300)}`);
}
