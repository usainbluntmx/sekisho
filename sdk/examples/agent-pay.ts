import { formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSekishoClient, createSekishoFetch } from "../src/index.js";

const SERVER_URL = "http://localhost:4021/premium";
const MERCHANT = "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae";

const privateKey = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;
if (!privateKey) throw new Error("Falta AGENT_PRIVATE_KEY en sdk/.env");

const account = privateKeyToAccount(privateKey);
const fmt = (v: bigint) => formatUnits(v, 6);

// Cliente Sekisho (lectura + distribute) y fetch con pagos
const sekisho = createSekishoClient({ network: "avalancheFuji", account });
const { fetch: payFetch, httpClient } = createSekishoFetch({
  account,
  maxPerPayment: "0.05", // el agente nunca paga más de 0.05 USDC por petición
});

console.log("─────────────────────────────────────────────");
console.log("Agente:  ", account.address);
console.log("Endpoint:", SERVER_URL);

const before = await sekisho.pending(MERCHANT);
console.log("Vault:   ", before.vault);
console.log("Saldo en vault antes:", fmt(before.total), "USDC");
console.log("─────────────────────────────────────────────");

// 1) Petición: recibe 402 → firma → reintenta → 200
const response = await payFetch(SERVER_URL);
const result = await httpClient.processResponse(response);

console.log("[1] Status:        ", response.status);
console.log("[1] Respuesta:     ", result.body);
console.log("[1] Estado del pago:", result.paymentStatus);
console.log("[1] Liquidación:   ", JSON.stringify(result.header, null, 2));

// 2) El pago quedó en el vault del vendedor
const after = await sekisho.pending(MERCHANT);
console.log("─────────────────────────────────────────────");
console.log(`[2] En el vault: ${fmt(after.total)} USDC → fee ${fmt(after.fee)} | vendedor ${fmt(after.merchantAmount)}`);

// 3) Repartir (cualquiera puede llamarlo; aquí lo hace el agente)
if (after.total > 0n) {
  const hash = await sekisho.distribute(MERCHANT);
  console.log(`[3] Reparto: ${sekisho.config.explorer}/tx/${hash}`);
}

const final = await sekisho.pending(MERCHANT);
console.log("[3] Saldo en vault después:", fmt(final.total), "USDC");
console.log("─────────────────────────────────────────────");