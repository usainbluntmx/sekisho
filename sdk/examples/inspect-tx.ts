import { decodeEventLog, formatUnits, getAddress, type Hash } from "viem";
import { createSekishoClient, erc20Abi, splitVaultAbi, splitVaultFactoryAbi } from "../src/index.js";
import { network } from "./env.js";

// Revisa transacciones de Sekisho directo en la cadena (sin depender del explorer):
//   SEKISHO_NETWORK=avalanche npm run example:inspect -- 0xhash1 0xhash2 ...

const SELECTORS: Record<string, string> = {
  "0xe3ee160e": "transferWithAuthorization (settlement x402, EIP-3009)",
  "0xb4bd6f46": "createVault",
  "0x63453ae1": "distribute",
};
// Eventos de los contratos v3 y Transfer de USDC: vienen en los ABI del SDK (desde 0.5.1)
const sekishoEventsAbi = [...splitVaultFactoryAbi, ...splitVaultAbi];

const hashes = process.argv.slice(2) as Hash[];
if (hashes.length === 0) throw new Error("Uso: npm run example:inspect -- 0xhash [0xhash ...]");

const sekisho = createSekishoClient({ network });
const { usdc, explorer } = sekisho.config;

for (const hash of hashes) {
  const [tx, receipt] = await Promise.all([
    sekisho.publicClient.getTransaction({ hash }),
    sekisho.publicClient.getTransactionReceipt({ hash }),
  ]);
  const block = await sekisho.publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const selector = tx.input.slice(0, 10);

  console.log("─────────────────────────────────────────────");
  console.log(`Tx:       ${explorer}/tx/${hash}`);
  console.log(`Estado:   ${receipt.status} · bloque ${receipt.blockNumber} · ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
  console.log(`De → a:   ${tx.from} → ${tx.to}`);
  console.log(`Función:  ${selector} ${SELECTORS[selector] ?? "(otra)"}`);
  console.log(`Gas:      ${receipt.gasUsed} · ${formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18)} AVAX`);

  for (const log of receipt.logs) {
    if (getAddress(log.address) === getAddress(usdc)) {
      try {
        const { args } = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics });
        console.log(`  USDC:   ${formatUnits(args.value, 6)} de ${args.from} → ${args.to}`);
        continue;
      } catch {
        // No es un Transfer (p. ej. AuthorizationUsed)
      }
    }
    try {
      const event = decodeEventLog({ abi: sekishoEventsAbi, data: log.data, topics: log.topics });
      const args = Object.entries(event.args ?? {})
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
      console.log(`  Evento: ${event.eventName} ${args} (en ${log.address})`);
    } catch {
      // Evento de otro contrato (p. ej. Initialized del clon o AuthorizationUsed del USDC)
    }
  }
}
console.log("─────────────────────────────────────────────");
