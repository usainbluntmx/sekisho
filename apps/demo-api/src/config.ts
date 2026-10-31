import { getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import type { DistributionPolicy, SekishoNetwork } from "@zero-two-labs/sekisho";

/**
 * Configuración desde el entorno. Si algo falta o es inválido,
 * el proceso se detiene con la lista completa de problemas.
 */
const env = process.env;
const problems: string[] = [];

const networkValue = env.NETWORK || "avalancheFuji";
if (!["avalancheFuji", "avalanche"].includes(networkValue)) {
  problems.push(`NETWORK: debe ser "avalancheFuji" o "avalanche" (es "${networkValue}")`);
}

const operatorKey = env.OPERATOR_PRIVATE_KEY ?? "";
if (!/^0x[0-9a-fA-F]{64}$/.test(operatorKey)) {
  problems.push("OPERATOR_PRIVATE_KEY: falta o no es 0x + 64 caracteres hexadecimales");
}

const merchantValue = env.MERCHANT_ADDRESS ?? "";
if (!isAddress(merchantValue)) problems.push("MERCHANT_ADDRESS: falta o no es una dirección 0x válida");

const priceValue = env.PRICE_USDC || "0.01";
try {
  if (parseUnits(priceValue, 6) <= 0n) problems.push("PRICE_USDC: debe ser mayor que 0");
} catch {
  problems.push(`PRICE_USDC: no es un monto válido ("${priceValue}")`);
}

if (env.AVALANCHE_RPC_URL && !/^https?:\/\/\S+$/.test(env.AVALANCHE_RPC_URL)) {
  problems.push("AVALANCHE_RPC_URL: formato inválido (URL que empiece con http:// o https://)");
}

function positiveNumber(name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!(parsed > 0)) problems.push(`${name}: debe ser un número mayor a 0`);
  return parsed;
}

const distributionPolicy: Partial<DistributionPolicy> = {};
for (const [name, key] of [
  ["DISTRIBUTE_MIN_USDC", "minUsdc"],
  ["DISTRIBUTE_AGE_MIN_USDC", "ageMinUsdc"],
] as const) {
  const value = env[name];
  if (!value) continue;
  try {
    parseUnits(value, 6);
    distributionPolicy[key] = value;
  } catch {
    problems.push(`${name}: no es un monto válido ("${value}")`);
  }
}
if (env.DISTRIBUTE_MAX_HOURS) distributionPolicy.maxHours = positiveNumber("DISTRIBUTE_MAX_HOURS", 24);
if (env.DISTRIBUTE_FEE_CHANGE_HOURS) {
  distributionPolicy.feeChangeHours = positiveNumber("DISTRIBUTE_FEE_CHANGE_HOURS", 48);
}

// Métricas on-chain (GET /v1/metrics)
const metricsEnabled = (env.METRICS || "on") !== "off";
const ownWallets: Address[] = [];
for (const raw of (env.METRICS_OWN_WALLETS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  if (isAddress(raw)) ownWallets.push(getAddress(raw));
  else problems.push(`METRICS_OWN_WALLETS: "${raw}" no es una dirección válida`);
}
let metricsFromBlock: bigint | undefined;
if (env.METRICS_FROM_BLOCK) {
  if (/^\d+$/.test(env.METRICS_FROM_BLOCK)) metricsFromBlock = BigInt(env.METRICS_FROM_BLOCK);
  else problems.push("METRICS_FROM_BLOCK: debe ser un número de bloque");
}
const metricsSyncSeconds = positiveNumber("METRICS_SYNC_SECONDS", 60);
const metricsMaxRange = positiveNumber("METRICS_MAX_RANGE", 2048);

const port = positiveNumber("PORT", 3000);
const checkMinutes = positiveNumber("DISTRIBUTE_CHECK_MINUTES", 15);
const ratePerMinute = positiveNumber("RATE_LIMIT_PER_MINUTE", 60);

if (problems.length > 0) {
  console.error(
    "[demo-api] Configuración inválida:\n" + problems.map((p) => `  • ${p}`).join("\n") + "\nRevisa .env.example"
  );
  process.exit(1);
}

export const config = {
  network: networkValue as SekishoNetwork,
  operatorKey: operatorKey as Hex,
  merchant: getAddress(merchantValue) as Address,
  priceUsdc: priceValue,
  rpcUrl: env.AVALANCHE_RPC_URL || undefined,
  distributionPolicy,
  checkMinutes,
  ratePerMinute,
  port,
  metrics: {
    enabled: metricsEnabled,
    ownWallets,
    fromBlock: metricsFromBlock,
    syncSeconds: metricsSyncSeconds,
    maxRange: Math.floor(metricsMaxRange),
  },
};
