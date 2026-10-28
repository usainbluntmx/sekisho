import { decodeEventLog, formatUnits, getAddress, parseAbi, type Hash } from "viem";
import { createSekishoClient } from "../src/index.js";
import { network } from "./env.js";

// Revisa transacciones de Sekisho directo en la cadena (sin depender del explorer):
//   SEKISHO_NETWORK=avalanche npm run example:inspect -- 0xhash1 0xhash2 ...

const SELECTORS: Record<string, string> = {
  "0xe3ee160e": "transferWithAuthorization (settlement x402, EIP-3009)",
  "0xb4bd6f46": "createVault",
  "0x63453ae1": "distribute",
};
const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
// Eventos de los contratos v3 (copiados de backend/contracts)
const sekishoEventsAbi = parseAbi([
  "event VaultCreated(address indexed merchant, address indexed vault)",
  "event MerchantRotated(address indexed vault, address indexed previousMerchant, address indexed newMerchant)",
  "event TreasuryUpdated(address indexed treasury)",
  "event FeeUpdated(uint16 feeBps)",
  "event FeeChangeScheduled(uint16 feeBps, uint64 effectiveAt)",
  "event FeeChangeCancelled(uint16 feeBps)",
  "event Distributed(address indexed token, uint256 total, uint256 fee, uint256 merchantAmount)",
  "event MerchantProposed(address indexed merchant, address indexed proposed)",
  "event MerchantChanged(address indexed previousMerchant, address indexed newMerchant)",
]);

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
        const { args } = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
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
