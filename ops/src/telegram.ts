const API = "https://api.telegram.org";
const LIMIT = 4000; // Telegram acepta hasta 4096 caracteres por mensaje

export interface TelegramConfig {
  token: string;
  chatId: string;
}

export function telegramFromEnv(env = process.env): TelegramConfig | undefined {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return undefined;
  if (!/^\d+:[\w-]{30,}$/.test(token)) throw new Error("TELEGRAM_BOT_TOKEN no tiene el formato de BotFather (número:clave)");
  return { token, chatId };
}

/** Parte un texto largo en mensajes, cortando en saltos de línea. */
export function chunks(text: string, limit = LIMIT): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    current = line.length <= limit ? line : line.slice(0, limit - 1) + "…";
  }
  if (current) out.push(current);
  return out;
}

/** Envía texto plano (sin parse_mode, así nada se escapa mal). El token nunca se imprime. */
export async function sendTelegram(config: TelegramConfig, text: string, fetchFn: typeof fetch = fetch): Promise<void> {
  for (const part of chunks(text)) {
    const res = await fetchFn(`${API}/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.chatId, text: part, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { description?: string };
      throw new Error(`Telegram respondió ${res.status}: ${body.description ?? "sin detalle"}`);
    }
  }
}

export async function getUpdates(token: string, fetchFn: typeof fetch = fetch) {
  const res = await fetchFn(`${API}/bot${token}/getUpdates`, { signal: AbortSignal.timeout(15_000) });
  const body = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: { message?: { chat: { id: number; type: string; title?: string; username?: string; first_name?: string } } }[];
  };
  if (!body.ok) throw new Error(`Telegram respondió: ${body.description ?? res.status}`);
  return body.result ?? [];
}
