/**
 * Revisión previa a mainnet. Solo lee: no firma ni manda transacciones.
 *
 * En el contenedor (con la base y las variables de producción):
 *   cd /app && node dist/scripts/mainnet-check.js
 * En local:
 *   npm run mainnet:check
 *
 * Sale con código 1 si algo impide ir a mainnet.
 */
import { erc20Abi, getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSekishoClient } from "@zero-two-labs/sekisho";
import { listStoresByStatus } from "../store.js";
import { walletVerifiedAt } from "../wallet-link.js";
import { evaluateMainnet, formatReport, type MainnetFacts } from "../mainnet-check.js";
import { oneLine } from "../errors.js";

const key = process.env.OPERATOR_PRIVATE_KEY as `0x${string}` | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("Falta OPERATOR_PRIVATE_KEY (la misma wallet operadora que usará Kanjō en mainnet).");
  process.exit(1);
}
const operator = privateKeyToAccount(key).address;

// AVALANCHE_RPC_URL apunta a la red de NETWORK: mientras siga en Fuji, aquí se usan las RPC públicas de mainnet
const rpcUrl = process.env.NETWORK === "avalanche" ? process.env.AVALANCHE_RPC_URL || undefined : undefined;
const sekisho = createSekishoClient({ network: "avalanche", rpcUrl });
const client = sekisho.publicClient;

let chainId: number, config: Awaited<ReturnType<typeof sekisho.getConfig>>, operatorWei: bigint, symbol: string, decimals: number;
try {
  [chainId, config, operatorWei] = await Promise.all([client.getChainId(), sekisho.getConfig(), client.getBalance({ address: operator })]);
  [symbol, decimals] = await Promise.all([
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "decimals" }),
  ]);
} catch (error) {
  console.error(`❌ No pude leer Avalanche mainnet: ${oneLine(error)}\nRevisa la conexión o la RPC y vuelve a correrlo.`);
  process.exit(1);
}

const stores: MainnetFacts["stores"] = [];
for (const s of listStoresByStatus("published")) {
  let payTo: MainnetFacts["stores"][number]["payTo"];
  try {
    payTo = { ok: true, vault: await sekisho.getPayTo(getAddress(s.merchant_address) as Address) };
  } catch (error) {
    payTo = { ok: false, error: (error as { shortMessage?: string }).shortMessage ?? (error as Error).message.split("\n")[0] };
  }
  stores.push({ id: s.id, name: s.name, merchant: s.merchant_address, verified: walletVerifiedAt(s.id) !== null, owner: s.owner, payTo });
}

const lines = evaluateMainnet({
  chainId,
  config: { factory: config.factory, usdc: config.usdc, treasury: config.treasury, feeBps: config.feeBps, feeChange: config.feeChange },
  usdc: { symbol, decimals },
  operator,
  operatorWei,
  stores,
  env: process.env,
});
console.log(formatReport(lines));
process.exit(lines.some((l) => l.level === "fail") ? 1 : 0);
