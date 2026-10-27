import { formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSekishoClient, createSekishoFetch } from "../src/index.js";
import { MERCHANT, network, requireKey } from "./env.js";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4021/premium";
// Segundos que espera a que el servidor reparta (0 para no esperar)
const WAIT_SECONDS = Number(process.env.WAIT_DISTRIBUTION_SECONDS ?? 60);

const account = privateKeyToAccount(requireKey("AGENT_PRIVATE_KEY"));
const fmt = (v: bigint) => formatUnits(v, 6);

// Cliente Sekisho (solo lectura) y fetch con pagos
const sekisho = createSekishoClient({ network });
const { fetch: payFetch, httpClient } = createSekishoFetch({
  account,
  network,
  maxPerPayment: "0.05", // nunca más de 0.05 USDC por petición
  maxPerDay: "1", // ni más de 1 USDC cada 24 horas
});

console.log("─────────────────────────────────────────────");
console.log("Agente:  ", account.address, `(${network})`);
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

// 3) El agente no reparte: lo hace el repartidor del servidor según su política
if (WAIT_SECONDS > 0 && after.total > 0n) {
  console.log(`[3] Esperando hasta ${WAIT_SECONDS} s a que el servidor reparta...`);
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let current = after;
  while (current.total > 0n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    current = await sekisho.pending(MERCHANT);
  }
  console.log(
    current.total === 0n
      ? "[3] Repartido: el vault quedó en 0 sin intervención manual."
      : `[3] Siguen ${fmt(current.total)} USDC en el vault: la política del servidor todavía no reparte (DISTRIBUTE_MIN_USDC).`
  );
}
console.log("─────────────────────────────────────────────");
