import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, executeTool } from "./tools.js";
import { getHistory, saveExchange } from "./memory.js";
import type { Store } from "./store.js";

const client = new Anthropic(); // lee ANTHROPIC_API_KEY del entorno
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const MAX_TOOL_ROUNDS = 6;

function buildSystemPrompt(store: Store, customerName: string): string {
  return `Eres el asistente de ventas por WhatsApp de "${store.name}". Atiendes a ${customerName || "un cliente"}.

Tu objetivo: ayudar al cliente a elegir productos y cerrar su pedido de forma amable y rápida.

Reglas:
- Responde en español, de forma breve y cálida, como en un chat de WhatsApp (2 a 5 líneas normalmente).
- Para negritas usa *un asterisco* (formato de WhatsApp). No uses Markdown con ## ni tablas.
- Antes de mencionar productos, precios o disponibilidad, consulta catalog_list. Nunca inventes productos ni precios.
- Los precios están en USDC.
- Antes de crear un pedido, resume productos, cantidades y total, y pide confirmación explícita. Solo después usa order_create.
- Al crear el pedido, comparte el id del pedido, el total y el link de pago (payment_url) tal cual.
- Cuando el pago se confirma, el cliente recibe un aviso automático; no necesitas prometer nada más.
- Responde solo lo que el cliente pidió. No ofrezcas productos adicionales a menos que el cliente pregunte o pida recomendaciones.
- Si una herramienta devuelve un error, explícalo en palabras simples y ofrece una alternativa.
- Si te preguntan algo fuera de la tienda, redirige amablemente a los productos.`;
}

export interface AgentInput {
  store: Store;
  customerWaId: string;
  customerName: string;
  text: string;
}

export async function runAgent(input: AgentInput): Promise<string> {
  const ctx = { storeId: input.store.id, customerWaId: input.customerWaId };

  const messages: Anthropic.MessageParam[] = [
    ...getHistory(input.customerWaId).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: input.text },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt(input.store, input.customerName),
      tools: TOOLS,
      messages,
    });

    // Sin herramientas pendientes: respuesta final al cliente
    if (response.stop_reason !== "tool_use") {
      const reply = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      const finalReply = reply || "¿Me lo puedes repetir, por favor? 🙂";
      saveExchange(input.customerWaId, input.text, finalReply);
      return finalReply;
    }

    // Ejecuta las herramientas y devuelve los resultados a Claude
    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const result = executeTool(block.name, block.input, ctx);
      console.log(`[agent] ${block.name}(${JSON.stringify(block.input)}) → ${result.isError ? "ERROR" : "ok"}`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      });
    }
    messages.push({ role: "user", content: results });
  }

  return "Perdón, tuve un problema procesando tu solicitud. ¿Lo intentamos de nuevo?";
}