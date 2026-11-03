import { getUpdates } from "./telegram.js";

// Muestra el chat id de quien le escribió al bot. Antes: abre tu bot en Telegram y mándale "hola".
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error("Falta TELEGRAM_BOT_TOKEN (cárgalo con: read -s TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN)");
  process.exit(1);
}

const updates = await getUpdates(token);
const chats = new Map<number, string>();
for (const u of updates) {
  const chat = u.message?.chat;
  if (chat) chats.set(chat.id, `${chat.type} · ${chat.title ?? chat.username ?? chat.first_name ?? ""}`);
}
if (chats.size === 0) {
  console.log('No hay mensajes. Abre tu bot en Telegram, mándale "hola" y vuelve a correr esto.');
} else {
  for (const [id, who] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${who})`);
}
