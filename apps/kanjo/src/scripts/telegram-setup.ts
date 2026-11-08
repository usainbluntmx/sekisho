import { listStores } from "../store.js";
import { setupTelegramWebhook, storeLink, telegramConfigured, telegramUsername, telegramWebhookInfo } from "../telegram.js";

// Canal de Telegram (usa TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET y PUBLIC_BASE_URL del entorno; nunca los imprime):
//   npm run telegram:setup              → registra el webhook en Telegram y muestra el link de cada tienda
//   npm run telegram:setup -- --info    → estado del webhook (pendientes y último error)
//   npm run telegram:setup -- --links   → solo los links por tienda

const args = process.argv.slice(2);
if (!telegramConfigured()) {
  console.error("✘ Falta TELEGRAM_BOT_TOKEN o no tiene el formato de BotFather (número:clave).");
  process.exit(1);
}

function printLinks(username: string): void {
  console.log(`\nBot: @${username}\nLinks para compartir (cada uno abre el bot con esa tienda):`);
  for (const s of listStores()) console.log(`  ${s.name.padEnd(28)} ${storeLink(username, s.id)}`);
}

try {
  if (args.includes("--info")) {
    const info = await telegramWebhookInfo();
    console.log(`Webhook: ${info.url || "(sin configurar)"}\nPendientes: ${info.pending_update_count}`);
    console.log(info.last_error_message ? `⚠️ Último error: ${info.last_error_message}` : "✅ Sin errores");
    process.exit(0);
  }
  if (args.includes("--links")) {
    printLinks(await telegramUsername());
    process.exit(0);
  }

  const base = process.env.PUBLIC_BASE_URL ?? "";
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!/^https:\/\//.test(base)) throw new Error("PUBLIC_BASE_URL debe ser https:// (Telegram solo llama a webhooks con HTTPS)");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error("TELEGRAM_WEBHOOK_SECRET falta o es inválido (genera uno con: openssl rand -hex 32)");

  const { username, url } = await setupTelegramWebhook(base, secret);
  console.log(`✅ Webhook registrado: ${url}`);
  printLinks(username);
} catch (error) {
  console.error(`✘ ${(error as Error).message}`);
  process.exit(1);
}
