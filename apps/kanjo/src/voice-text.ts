/**
 * Reglas de texto para voz (sin red: se prueban offline).
 */

/**
 * Texto que se lee en voz alta: sin links, sin formato de WhatsApp y sin emojis.
 * Un link leído en voz es inservible; el canal web lo muestra en pantalla.
 */
export function spokenText(text: string, maxChars = Number(process.env.VOICE_MAX_CHARS ?? 600)): string {
  return text
    .replace(/https?:\/\/\S+/gi, "")
    // Ids de pedido (8 caracteres hex, p. ej. 09D37429): se ven en pantalla, no se leen
    .replace(/\b(?=[0-9A-F]*\d)(?=[0-9A-F]*[A-F])[0-9A-F]{8}\b/g, "")
    .replace(/Link de pago:?/gi, "")
    .replace(/[*_~`]/g, "")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    // Montos: "6.85 USDC" se dice "6 dólares con 85"; "2.00 USDC", "2 dólares"
    .replace(/(\d+)(?:\.(\d{1,2}))?\s*USDC\b/g, (_match, whole: string, cents?: string) => {
      const c = cents ? cents.padEnd(2, "0") : "00";
      const unit = whole === "1" ? "dólar" : "dólares";
      return c === "00" ? `${whole} ${unit}` : `${whole} ${unit} con ${Number(c)}`;
    })
    // Viñetas y saltos de línea se leen como pausas
    .replace(/^[ \t]*[-•][ \t]+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/([.:;,!?¿¡])\. /g, "$1 ")
    .replace(/\.{2,}/g, ".")
    .trim()
    .slice(0, maxChars);
}

/**
 * ¿Responder con nota de voz por WhatsApp?
 *  1. Solo si la función está encendida y el cliente mandó audio (espejeamos el canal).
 *  2. Nunca si la respuesta trae un link: el payment_url debe llegar como texto.
 *  3. Nunca si excede el máximo de caracteres (costo y latencia).
 */
export function shouldReplyWithVoice(input: {
  enabled: boolean;
  inboundType: string;
  text: string;
  maxChars: number;
}): boolean {
  if (!input.enabled) return false;
  if (input.inboundType !== "audio") return false;
  if (/https?:\/\//i.test(input.text)) return false;
  return input.text.length <= input.maxChars;
}
