#!/usr/bin/env node
/**
 * npm create @zero-two-labs/sekisho <carpeta> -- --merchant 0xTuWallet [--network avalanche] [--price 0.05]
 *
 * Crea un servidor que cobra USDC por llamada con x402 en Avalanche, usando Sekisho.
 * Genera una llave de operador nueva en .env (permisos 600); nunca la imprime.
 * Sin dependencias: solo Node.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const NETWORKS = ["avalancheFuji", "avalanche"];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRICE_RE = /^\d+(\.\d{1,6})?$/;

function usage(message) {
  if (message) console.error(`\n✘ ${message}\n`);
  console.error(
    "Uso: npm create @zero-two-labs/sekisho <carpeta> -- --merchant 0xTuWallet [--network avalancheFuji|avalanche] [--price 0.01]"
  );
  process.exit(1);
}

export function parseArgs(argv) {
  const options = { dir: undefined, merchant: undefined, network: "avalancheFuji", price: "0.01" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) usage(`Falta el valor de ${arg}`);
      return value;
    };
    if (arg === "--merchant") options.merchant = next();
    else if (arg === "--network") options.network = next();
    else if (arg === "--price") options.price = next();
    else if (arg === "--help" || arg === "-h") usage();
    else if (arg.startsWith("--")) usage(`Opción desconocida: ${arg}`);
    else if (!options.dir) options.dir = arg;
    else usage(`Argumento de más: ${arg}`);
  }
  return options;
}

export function validate(options) {
  if (!options.dir) return "Indica la carpeta del proyecto";
  if (!/^[a-zA-Z0-9._-]+$/.test(basename(options.dir))) return "El nombre de la carpeta solo puede tener letras, números, . _ -";
  if (!options.merchant || !ADDRESS_RE.test(options.merchant)) return "--merchant debe ser una dirección 0x de 40 caracteres hex (tu wallet, que recibe el 98.5%)";
  if (!NETWORKS.includes(options.network)) return `--network debe ser ${NETWORKS.join(" o ")}`;
  if (!PRICE_RE.test(options.price) || Number(options.price) <= 0) return "--price debe ser un monto en USDC mayor a 0 (máximo 6 decimales)";
  return null;
}

/** Crea el proyecto. Devuelve la ruta absoluta. */
export function scaffold(options) {
  const target = resolve(options.dir);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`La carpeta ${options.dir} ya existe y no está vacía`);
  }

  const templateDir = join(dirname(fileURLToPath(import.meta.url)), "template");
  cpSync(templateDir, target, { recursive: true });
  // npm no publica archivos que empiezan con punto en algunos casos: se guardan con "_" y se renombran
  renameSync(join(target, "_gitignore"), join(target, ".gitignore"));
  renameSync(join(target, "_env.example"), join(target, ".env.example"));

  const pkgPath = join(target, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = basename(target).toLowerCase();
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // Llave nueva del operador: liquida pagos y reparte. Solo necesita AVAX; no tiene permisos en los contratos.
  const operatorKey = `0x${randomBytes(32).toString("hex")}`;
  const env = [
    "# Generado por create-sekisho. NO subas este archivo a git.",
    `NETWORK=${options.network}`,
    `MERCHANT_ADDRESS=${options.merchant}`,
    `OPERATOR_PRIVATE_KEY=${operatorKey}`,
    `PRICE_USDC=${options.price}`,
    "PORT=3000",
    "",
  ].join("\n");
  const envPath = join(target, ".env");
  writeFileSync(envPath, env, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  return target;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.merchant && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    options.dir ??= (await rl.question("Carpeta del proyecto (sekisho-api): ")).trim() || "sekisho-api";
    options.merchant = (await rl.question("Tu wallet (recibe el 98.5% de cada pago): ")).trim();
    rl.close();
  }
  options.dir ??= "sekisho-api";
  const error = validate(options);
  if (error) usage(error);

  let target;
  try {
    target = scaffold(options);
  } catch (err) {
    usage(err.message);
  }

  const mainnet = options.network === "avalanche";
  console.log(`
✔ Proyecto creado en ${target}

  Red:       ${options.network}${mainnet ? " (mainnet, USDC real)" : " (testnet)"}
  Vendedor:  ${options.merchant}
  Precio:    ${options.price} USDC por llamada
  Operador:  llave nueva en .env (permisos 600). Nunca la compartas.

Siguientes pasos:

  cd ${options.dir}
  npm install
  npm run dev

Al arrancar verás la dirección del operador: mándale un poco de AVAX${mainnet ? "" : " de Fuji (de cualquier faucet de Fuji)"}
para el gas de cada cobro. Luego prueba tu endpoint con: npm run pay${mainnet ? "" : "\n(el pagador necesita USDC de Fuji: https://faucet.circle.com)"}
`);
}

// Se ejecuta como comando (npm create usa un enlace en node_modules/.bin), no al importarlo en los tests
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
