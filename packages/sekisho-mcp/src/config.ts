import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseUnits, type Hex } from "viem";
import type { SekishoNetwork } from "@zero-two-labs/sekisho";

export interface ProxyConfig {
  /** MCP remoto de pago (Streamable HTTP). */
  url: URL;
  network: SekishoNetwork;
  /** Tope por llamada y por 24 h, en USDC atómico (6 decimales). */
  maxPerCall: bigint;
  maxPerDay: bigint;
  keyFile: string;
  ledgerFile: string;
}

export const configDir = (env: NodeJS.ProcessEnv) => env.SEKISHO_HOME || join(homedir(), ".config", "sekisho");

/** Lee la configuración de variables de entorno. Si algo está mal, lanza un error con TODOS los problemas. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const problems: string[] = [];

  let url: URL | undefined;
  try {
    url = new URL(env.SEKISHO_MCP_URL ?? "");
    if (!["https:", "http:"].includes(url.protocol)) problems.push("SEKISHO_MCP_URL debe ser http(s)");
    if (url.protocol === "http:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
      problems.push("SEKISHO_MCP_URL: usa https (http solo se permite en localhost)");
    }
  } catch {
    problems.push("SEKISHO_MCP_URL: falta o no es una URL (por ejemplo https://sekisho-api.zerotwolabs.xyz/mcp)");
  }

  const network = (env.SEKISHO_NETWORK || "avalancheFuji") as SekishoNetwork;
  if (!["avalancheFuji", "avalanche"].includes(network)) problems.push('SEKISHO_NETWORK debe ser "avalancheFuji" o "avalanche"');

  const amount = (name: string, fallback: string) => {
    const value = env[name] || fallback;
    try {
      const atomic = parseUnits(value, 6);
      if (atomic <= 0n) throw new Error();
      return atomic;
    } catch {
      problems.push(`${name}: "${value}" no es un monto en USDC mayor que 0`);
      return 0n;
    }
  };
  const maxPerCall = amount("SEKISHO_MAX_PER_CALL", "0.05");
  const maxPerDay = amount("SEKISHO_MAX_PER_DAY", "1");
  if (maxPerCall > maxPerDay && maxPerDay > 0n) problems.push("SEKISHO_MAX_PER_CALL no puede ser mayor que SEKISHO_MAX_PER_DAY");

  const dir = configDir(env);
  const keyFile = resolve(env.SEKISHO_PAYER_KEY_FILE || join(dir, "payer.key"));
  const ledgerFile = resolve(env.SEKISHO_LEDGER_FILE || join(dir, "spend.json"));

  if (problems.length > 0) throw new Error(`Configuración inválida:\n  • ${problems.join("\n  • ")}`);
  return { url: url!, network, maxPerCall, maxPerDay, keyFile, ledgerFile };
}

/**
 * Lee la llave del pagador de un archivo privado (nunca de la config del editor).
 * Se niega si el archivo lo pueden leer otros usuarios: debe tener permisos 600.
 */
export function readPayerKey(file: string): Hex {
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new Error(`No existe el archivo de la llave del pagador: ${file} (créalo con permisos 600, ver README)`);
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new Error(`${file} lo pueden leer otros usuarios (permisos ${(mode & 0o777).toString(8)}). Ejecuta: chmod 600 "${file}"`);
  }
  const key = readFileSync(file, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${file} no contiene una llave 0x + 64 hexadecimales`);
  return key as Hex;
}
