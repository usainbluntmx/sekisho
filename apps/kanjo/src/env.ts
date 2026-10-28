/**
 * Validación de variables de entorno. Se importa primero en index.ts:
 * si algo falta, el proceso se detiene con la lista completa de problemas.
 */
const env = process.env;
const problems: string[] = [];

function required(name: string, valid?: (value: string) => boolean, hint?: string): void {
  const value = env[name];
  if (!value) {
    problems.push(`${name}: falta`);
  } else if (valid && !valid(value)) {
    problems.push(`${name}: formato inválido${hint ? ` (${hint})` : ""}`);
  }
}

function positiveNumber(name: string): void {
  const value = env[name];
  if (value !== undefined && value !== "" && !(Number(value) > 0)) {
    problems.push(`${name}: debe ser un número mayor a 0`);
  }
}

required("OPERATOR_PRIVATE_KEY", (v) => /^0x[0-9a-fA-F]{64}$/.test(v), "0x + 64 caracteres hexadecimales");
required("ANTHROPIC_API_KEY");
required("MERCHANT_ADDRESS", (v) => /^0x[0-9a-fA-F]{40}$/.test(v), "dirección 0x de 40 caracteres hexadecimales");
required("PUBLIC_BASE_URL", (v) => /^https?:\/\/\S+$/.test(v), "URL que empiece con http:// o https://");
const network = env.NETWORK || "avalancheFuji";
if (!["avalancheFuji", "avalanche"].includes(network)) {
  problems.push(`NETWORK: debe ser "avalancheFuji" o "avalanche" (es "${network}")`);
}
for (const name of ["AVALANCHE_RPC_URL", "AVALANCHE_FUJI_RPC_URL"]) {
  const value = env[name];
  if (value && !/^https?:\/\/\S+$/.test(value)) {
    problems.push(`${name}: formato inválido (URL que empiece con http:// o https://)`);
  }
}
if (network === "avalanche" && env.AVALANCHE_FUJI_RPC_URL && !env.AVALANCHE_RPC_URL) {
  console.warn("[kanjo] AVALANCHE_FUJI_RPC_URL se ignora en mainnet; usa AVALANCHE_RPC_URL para una RPC propia.");
}

const channel = env.NOTIFY_CHANNEL ?? "console";
if (!["console", "whatsapp"].includes(channel)) {
  problems.push(`NOTIFY_CHANNEL: debe ser "console" o "whatsapp" (es "${channel}")`);
}
if (channel === "whatsapp") {
  required("WHATSAPP_TOKEN");
  required("WHATSAPP_PHONE_NUMBER_ID");
}
if (env.WHATSAPP_TOKEN && !env.WHATSAPP_APP_SECRET) {
  problems.push("WHATSAPP_APP_SECRET: falta (sin ella el webhook rechaza todos los mensajes)");
}

// Catálogo desde URL (Firecrawl) y voz (ElevenLabs): apagadas no cambian nada
for (const name of ["VOICE_REPLIES", "VOICE_WEB"]) {
  if (env[name] && !["on", "off"].includes(env[name]!)) problems.push(`${name}: debe ser "on" u "off"`);
}
if (env.VOICE_REPLIES === "on" || env.VOICE_WEB === "on") {
  required("ELEVENLABS_API_KEY");
  required("ELEVENLABS_VOICE_ID");
}
if (env.FX_MXN_PER_USDC && !(Number(env.FX_MXN_PER_USDC) > 0)) {
  problems.push("FX_MXN_PER_USDC: debe ser un número mayor a 0");
}
positiveNumber("CATALOG_DEFAULT_STOCK");
positiveNumber("CATALOG_MAX_ITEMS");
positiveNumber("VOICE_MAX_CHARS");
positiveNumber("VOICE_WEB_PER_MINUTE");

const mode = env.DISTRIBUTE_MODE ?? "batch";
if (!["batch", "each"].includes(mode)) {
  problems.push(`DISTRIBUTE_MODE: debe ser "batch" o "each" (es "${mode}")`);
}
positiveNumber("DISTRIBUTE_MIN_USDC");
positiveNumber("DISTRIBUTE_MAX_HOURS");
positiveNumber("DISTRIBUTE_AGE_MIN_USDC");
if (env.DISTRIBUTE_STALE_HOURS) {
  console.warn("[kanjo] DISTRIBUTE_STALE_HOURS ya no se usa: nada debajo de DISTRIBUTE_AGE_MIN_USDC se reparte solo.");
}
positiveNumber("DISTRIBUTE_FEE_CHANGE_HOURS");
positiveNumber("DISTRIBUTE_CHECK_MINUTES");
positiveNumber("HISTORY_HOURS");

if (problems.length > 0) {
  console.error(
    "[kanjo] Configuración inválida:\n" +
      problems.map((p) => `  • ${p}`).join("\n") +
      "\nRevisa apps/kanjo/.env.example"
  );
  process.exit(1);
}