import { getCustomerStore, getStore, setCustomerStore, upsertCustomer } from "./store.js";
import { clearHistory } from "./memory.js";
import { runAgent } from "./agent.js";


export interface ChatMessage {
  from: string;
  name: string;
  type: string;
  text?: string;
}

/**
 * Cómo responder: WhatsApp en producción, consola en el chat local, JSON en el canal web.
 * `voice` indica que el cliente habló (mandó audio); cada canal decide si contesta en voz.
 */
export type Reply = (to: string, text: string, opts?: { voice?: boolean }) => Promise<void>;

export async function handleMessage(msg: ChatMessage, reply: Reply): Promise<void> {
  if (!msg.text) {
    return reply(
      msg.from,
      msg.type === "audio"
        ? "No alcancé a escuchar bien tu audio 🙈 ¿Me lo mandas otra vez o me lo escribes?"
        : "Por ahora entiendo mensajes de texto y audios 🙂"
    );
  }

  upsertCustomer(msg.from, msg.name);

  // Cambiar de tienda: "/tienda <id>" (WhatsApp) o "/start <id>" (link t.me/<bot>?start=<id> de Telegram)
  const switchTo = msg.text.trim().match(/^\/(?:tienda|start)\s+([a-z0-9-]{3,40})$/i);
  if (switchTo) {
    const target = getStore(switchTo[1].toLowerCase());
    if (!target || !setCustomerStore(msg.from, target.id)) {
      return reply(msg.from, "No encontré esa tienda 🙈 Revisa el link que te compartieron.");
    }
    clearHistory(msg.from); // la conversación anterior era con otra tienda
    return reply(msg.from, `¡Hola! Ahora estás con *${target.name}* 🙂 ¿En qué te ayudo?`);
  }

  const store = getCustomerStore(msg.from);
  if (!store) {
    return reply(msg.from, "La tienda aún no está configurada.");
  }

  // "/start" sin tienda (abrir el bot directo): saludo con la tienda actual, sin gastar una llamada al agente
  if (msg.text.trim().toLowerCase() === "/start") {
    return reply(msg.from, `¡Hola! Estás con *${store.name}* 🙂 ¿En qué te ayudo?`);
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
      voice: msg.type === "audio",
    });
    await reply(msg.from, answer, { voice: msg.type === "audio" });
  } catch (error) {
    console.error("[bot] Error del agente:", error);
    await reply(msg.from, "Tuve un problema técnico 😅 ¿Me escribes de nuevo en un momento?");
  }
}