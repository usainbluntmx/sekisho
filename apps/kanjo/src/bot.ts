import { getStore, upsertCustomer } from "./store.js";
import { clearHistory } from "./memory.js";
import { runAgent } from "./agent.js";

const STORE_ID = process.env.STORE_ID ?? "cafe-kanjo";

export interface ChatMessage {
  from: string;
  name: string;
  type: string;
  text?: string;
}

/** Cómo responder: WhatsApp en producción, consola en el chat local. */
export type Reply = (to: string, text: string) => Promise<void>;

export async function handleMessage(msg: ChatMessage, reply: Reply): Promise<void> {
  if (!msg.text) {
    return reply(msg.from, "Por ahora solo entiendo mensajes de texto 🙂");
  }

  upsertCustomer(msg.from, msg.name);

  const store = getStore(STORE_ID);
  if (!store) {
    return reply(msg.from, "La tienda aún no está configurada.");
  }

  // Comando de soporte: reinicia la conversación
  if (msg.text.trim().toLowerCase() === "/reiniciar") {
    clearHistory(msg.from);
    return reply(msg.from, "Listo, empezamos de nuevo 🙂 ¿En qué te ayudo?");
  }

  try {
    const answer = await runAgent({
      store,
      customerWaId: msg.from,
      customerName: msg.name,
      text: msg.text,
    });
    await reply(msg.from, answer);
  } catch (error) {
    console.error("[bot] Error del agente:", error);
    await reply(msg.from, "Tuve un problema técnico 😅 ¿Me escribes de nuevo en un momento?");
  }
}