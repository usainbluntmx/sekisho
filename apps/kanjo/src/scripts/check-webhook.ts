import { createHmac } from "node:crypto";

const PORT = process.env.PORT ?? "3000";
const SECRET = process.env.WHATSAPP_APP_SECRET ?? "";
if (!SECRET) throw new Error("Define WHATSAPP_APP_SECRET en .env (para la prueba local sirve cualquier valor)");

const WEBHOOK_URL = `http://localhost:${PORT}/webhook`;
const FROM = "5215500000099";

/** Payload con el mismo formato que envía Meta. */
function payload(id: string, text: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "0",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: "Prueba Webhook" }, wa_id: FROM }],
              messages: [
                {
                  from: FROM,
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function post(body: string, signature?: string): Promise<{ status: number; ms: number }> {
  const sig = signature ?? "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  const start = performance.now();
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig },
    body,
  });
  return { status: res.status, ms: Math.round(performance.now() - start) };
}

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}

const id = `wamid.TEST-${Date.now()}`;
const first = payload(id, "hola, ¿qué tienen?");

const r1 = await post(first);
const r2 = await post(first); // reintento de Meta: mismo id
const r3 = await post(payload(`${id}-2`, "¿y cuánto cuesta el latte?"));
const bad = await post(first, "sha256=00");

check(`Mensaje 1 → 200 en ${r1.ms} ms (sin esperar al agente)`, r1.status === 200 && r1.ms < 1000);
check(`Reintento con el mismo id → 200 en ${r2.ms} ms`, r2.status === 200 && r2.ms < 1000);
check(`Mensaje 2 del mismo cliente → 200 en ${r3.ms} ms`, r3.status === 200 && r3.ms < 1000);
check("Firma inválida → 401", bad.status === 401);

console.log(failures === 0 ? "\n✅ Respuestas HTTP correctas" : `\n❌ ${failures} prueba(s) fallaron`);
console.log("Revisa la Terminal 1: un 'Duplicado ignorado' y DOS respuestas del agente, en orden.");
if (failures > 0) process.exitCode = 1;