import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSekishoClient, createSekishoDistributor } from "../src/index.js";
import { MERCHANT, network, policyFromEnv, requireKey } from "./env.js";

// Keeper independiente: reparte los vaults de uno o varios vendedores sin tocar el servidor que cobra.
// distribute() no tiene permisos: cualquier llave con AVAX puede correrlo y los fondos solo van
// al vendedor y a la tesorería.
//
//   npm run example:keeper            → revisa cada KEEPER_INTERVAL_MINUTES (15 por defecto)
//   npm run example:keeper -- --once  → una sola revisión y termina (para cron)
//   ... -- --once --force             → reparte todo lo pendiente, sin importar la política

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const force = args.has("--force");

const merchants: Address[] = process.env.MERCHANTS
  ? process.env.MERCHANTS.split(",").map((value) => getAddress(value.trim()))
  : [MERCHANT];

const account = privateKeyToAccount(requireKey(process.env.KEEPER_PRIVATE_KEY ? "KEEPER_PRIVATE_KEY" : "FACILITATOR_PRIVATE_KEY"));
const sekisho = createSekishoClient({ network, account });

const distributor = createSekishoDistributor({
  sekisho,
  merchants,
  policy: policyFromEnv(),
  intervalMinutes: Number(process.env.KEEPER_INTERVAL_MINUTES ?? 15),
});

console.log("─────────────────────────────────────────────");
console.log(`Keeper:     ${account.address} (${network})`);
console.log(`Vendedores: ${merchants.join(", ")}`);
console.log(`Política:   ${JSON.stringify(distributor.policy)}`);
console.log("─────────────────────────────────────────────");

if (once) {
  const results = await distributor.check({ force });
  for (const result of results) {
    const detail = result.tx ? `${sekisho.config.explorer}/tx/${result.tx}` : result.error ?? "";
    console.log(`${result.merchant}: ${result.pending} USDC → ${result.decision.reason} ${detail}`);
  }
  process.exit(results.some((result) => result.error) ? 1 : 0);
}

distributor.start();
