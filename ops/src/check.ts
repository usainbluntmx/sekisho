import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "./collect.js";
import { formatNotification, formatReport } from "./report.js";
import { evaluate } from "./rules.js";
import { loadState, planNotification, saveState } from "./state.js";
import { sendTelegram, telegramFromEnv } from "./telegram.js";
import type { Net, Watch } from "./types.js";

// Uso:
//   npm run check                 → reporte en la terminal (no envía nada)
//   npm run check -- --notify     → envía a Telegram solo lo que cambió (alertas nuevas, resueltas, recordatorios)
//   npm run check -- --summary    → envía el reporte completo a Telegram (resumen diario)
const args = new Set(process.argv.slice(2));
const notify = args.has("--notify");
const summary = args.has("--summary");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const watch = JSON.parse(readFileSync(resolve(root, "watch.json"), "utf8")) as Watch;
const statePath = resolve(root, process.env.OPS_STATE_FILE || ".state/state.json");

const telegram = notify || summary ? telegramFromEnv() : undefined;
if ((notify || summary) && !telegram) {
  console.error("Faltan TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID para enviar a Telegram (ver .env.example)");
  process.exit(1);
}

try {
  const prev = loadState(statePath);
  const adminScannedTo = Object.fromEntries(
    Object.entries(prev.adminScannedTo).map(([net, block]) => [net, BigInt(block as string)])
  ) as Partial<Record<Net, bigint>>;

  const facts = await collect(watch, { adminScannedTo });
  const alerts = evaluate(facts, watch.rules);
  const report = formatReport(facts, alerts);
  console.log(report);

  const plan = planNotification(prev, alerts, facts.at, watch.rules.remindEveryHours);
  for (const [net, block] of Object.entries(facts.adminScannedTo)) plan.next.adminScannedTo[net as Net] = block.toString();

  if (summary) await sendTelegram(telegram!, report);
  else if (notify && plan.shouldSend) await sendTelegram(telegram!, formatNotification(plan, facts.at));

  // En modo solo-lectura (sin flags) el estado no se toca: no "consume" alertas que nadie recibió
  if (notify || summary) saveState(statePath, plan.next);
  console.log(
    notify || summary
      ? `\n[ops] ${summary ? "Resumen enviado" : plan.shouldSend ? "Aviso enviado" : "Sin cambios: no se envió nada"} a Telegram`
      : ""
  );
} catch (error) {
  console.error(`[ops] El chequeo falló: ${(error as Error).message}`);
  if (telegram) {
    await sendTelegram(telegram, `Sekisho · el monitor falló: ${(error as Error).message.split("\n")[0]}`).catch(() => {});
  }
  process.exit(1);
}
