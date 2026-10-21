import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { handleMessage } from "./bot.js";

// Cliente simulado (formato de número como lo entrega WhatsApp en México)
const FROM = process.env.DEV_CHAT_FROM ?? "5215500000000";
const NAME = process.env.DEV_CHAT_NAME ?? "Ricardo";

const rl = createInterface({ input, output });
console.log("Kanjō · chat local (escribe 'salir' para terminar)\n");

while (true) {
  const text = (await rl.question("Tú: ")).trim();
  if (!text) continue;
  if (text.toLowerCase() === "salir") break;

  await handleMessage({ from: FROM, name: NAME, type: "text", text }, async (_to, body) => {
    console.log(`\nKanjō: ${body}\n`);
  });
}

rl.close();