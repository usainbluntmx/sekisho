import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { createSekishoFetch, type SekishoNetwork } from "@zero-two-labs/sekisho";

// Paga tu propio endpoint como lo haría un agente: 402 → firma EIP-3009 → 200
const key = process.env.PAYER_PRIVATE_KEY as Hex | undefined;
if (!key) {
  console.error("Agrega PAYER_PRIVATE_KEY a .env: una wallet con USDC de la red (no la del operador).");
  process.exit(1);
}

const network = (process.env.NETWORK || "avalancheFuji") as SekishoNetwork;
const url = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 3000}/premium`;
const { fetch: pay, httpClient } = createSekishoFetch({
  account: privateKeyToAccount(key),
  network,
  maxPerPayment: process.env.PRICE_USDC || "0.01",
});

const res = await pay(url);
const result = await httpClient.processResponse(res);
console.log("Status:", res.status);
console.log("Respuesta:", result.body);
console.log("Pago:", JSON.stringify(result.header, null, 2));
