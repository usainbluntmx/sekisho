import { createPublicClient, http, formatGwei, type Hash } from "viem";
import { avalanche, avalancheFuji } from "viem/chains";

// Transacciones reales del pedido 71AB6720 (Fuji)
const SETTLE_TX = (process.env.SETTLE_TX ??
  "0x59f349080734cb8f8b652ed119a410b4f7d3dc5b5843dd83a8e0117f2cd30e73") as Hash;
const DISTRIBUTE_TX = (process.env.DISTRIBUTE_TX ??
  "0x5f791d07955b5db62f30d0e9945af78c02e01a2a3369ff5f4f2b490fcce5c7ad") as Hash;

const FEE_RATE = 0.015; // 1.5%
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 20); // pedidos por reparto en modo lote
const TICKETS = [0.02, 0.1, 0.5, 1, 3, 5, 10];

const fuji = createPublicClient({ chain: avalancheFuji, transport: http() });
const mainnet = createPublicClient({ chain: avalanche, transport: http() });

async function avaxUsd(): Promise<number> {
  if (process.env.AVAX_USD) return Number(process.env.AVAX_USD);
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=avalanche-2&vs_currencies=usd");
  if (!res.ok) throw new Error("No se pudo leer el precio de AVAX. Ejecuta con AVAX_USD=<precio>");
  const data = (await res.json()) as { "avalanche-2": { usd: number } };
  return data["avalanche-2"].usd;
}

const [settle, distribute, gasPrice, block, price] = await Promise.all([
  fuji.getTransactionReceipt({ hash: SETTLE_TX }),
  fuji.getTransactionReceipt({ hash: DISTRIBUTE_TX }),
  mainnet.getGasPrice(),
  mainnet.getBlock(),
  avaxUsd(),
]);

const usd = (gas: bigint) => (Number(gas * gasPrice) / 1e18) * price;
const settleUsd = usd(settle.gasUsed);
const distributeUsd = usd(distribute.gasUsed);

const perOrderEach = settleUsd + distributeUsd; // reparto en cada pedido
const perOrderBatch = settleUsd + distributeUsd / BATCH_SIZE; // reparto cada N pedidos

const fmt = (n: number) => `$${n.toFixed(6)}`;

console.log("─────────────────────────────────────────────");
console.log("Gas usado (medido en Fuji, igual en mainnet)");
console.log(`  Liquidación (transferWithAuthorization): ${settle.gasUsed} gas`);
console.log(`  Reparto (distribute):                    ${distribute.gasUsed} gas`);
console.log("Avalanche mainnet ahora");
console.log(`  Gas price: ${formatGwei(gasPrice)} nAVAX   Base fee: ${formatGwei(block.baseFeePerGas ?? 0n)} nAVAX`);
console.log(`  AVAX: $${price}`);
console.log("Costo en USD");
console.log(`  Por liquidación: ${fmt(settleUsd)}`);
console.log(`  Por reparto:     ${fmt(distributeUsd)}`);
console.log(`  Por pedido (reparto en cada pedido):   ${fmt(perOrderEach)}`);
console.log(`  Por pedido (reparto cada ${BATCH_SIZE} pedidos): ${fmt(perOrderBatch)}`);
console.log("Ticket mínimo para que el fee de 1.5% cubra el gas");
console.log(`  Reparto en cada pedido: $${(perOrderEach / FEE_RATE).toFixed(4)}`);
console.log(`  Reparto por lotes:      $${(perOrderBatch / FEE_RATE).toFixed(4)}`);
console.log("─────────────────────────────────────────────");
console.log("Ticket    Fee 1.5%     Margen (cada pedido)   Margen (por lotes)");
for (const t of TICKETS) {
  const fee = t * FEE_RATE;
  console.log(
    `$${t.toFixed(2).padEnd(7)} ${fmt(fee).padEnd(12)} ${fmt(fee - perOrderEach).padEnd(22)} ${fmt(fee - perOrderBatch)}`
  );
}
console.log("─────────────────────────────────────────────");