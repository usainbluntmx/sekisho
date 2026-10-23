import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION ?? "v23.0";
const TOKEN = process.env.WHATSAPP_TOKEN ?? "";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? "";

export interface IncomingMessage {
  from: string;
  name: string;
  id: string;
  type: string;
  text?: string;
}

/**
 * Verifica que el webhook venga de Meta (header X-Hub-Signature-256).
 */
export function isValidSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!APP_SECRET || !signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Extrae los mensajes entrantes del payload del webhook.
 * Ignora eventos de estado (sent/delivered/read).
 */
export function parseIncomingMessages(body: any): IncomingMessage[] {
  const messages: IncomingMessage[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const name = value?.contacts?.[0]?.profile?.name ?? "";
      for (const m of value?.messages ?? []) {
        messages.push({
          from: m.from,
          name,
          id: m.id,
          type: m.type,
          text: m.type === "text" ? m.text?.body : undefined,
        });
      }
    }
  }
  return messages;
}

/**
 * Números de México: WhatsApp entrega el remitente como 521XXXXXXXXXX,
 * pero la API espera 52XXXXXXXXXX para responder.
 */
export function normalizeRecipient(waId: string): string {
  if (waId.startsWith("521") && waId.length === 13) {
    return "52" + waId.slice(3);
  }
  return waId;
}

/** Envía un mensaje de texto. Sin credenciales de Meta, lo imprime en consola (modo prueba). */
export async function sendText(to: string, body: string): Promise<void> {
  if (!TOKEN || !PHONE_NUMBER_ID) {
    console.log(`\n[whatsapp:dry-run → ${to}]\n${body}\n`);
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizeRecipient(to),
      type: "text",
      text: { body },
    }),
  });

  if (!res.ok) {
    throw new Error(`WhatsApp respondió ${res.status}: ${await res.text()}`);
  }
}