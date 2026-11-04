import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Paga un endpoint de Sekisho con el cliente x402 estándar, SIN el SDK de Sekisho.
//   TARGET_URL=http://127.0.0.1:4402/v1/avalanche/snapshot npm run pay      (servidor local, llave desechable)
//   TARGET_URL=https://... PAYER_PRIVATE_KEY=0x... NETWORK=avalanche npm run pay
// Si el servidor pide más de MAX_USDC (0.01 por defecto), no firma.

const USDC = {
  avalancheFuji: { caip2: "eip155:43113", asset: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  avalanche: { caip2: "eip155:43114", asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" },
} as const;

const url = process.env.TARGET_URL ?? "http://127.0.0.1:4402/v1/avalanche/snapshot";
const network = (process.env.NETWORK ?? "avalancheFuji") as keyof typeof USDC;
const max = parseUnits(process.env.MAX_USDC ?? "0.01", 6);
if (!(network in USDC)) throw new Error(`NETWORK debe ser avalancheFuji o avalanche (es "${network}")`);

const key = (process.env.PAYER_PRIVATE_KEY as Hex | undefined) ?? (url.includes("127.0.0.1") ? generatePrivateKey() : undefined);
if (!key) throw new Error("Falta PAYER_PRIVATE_KEY (solo el servidor local de interop acepta una llave desechable)");
const account = privateKeyToAccount(key);

const decode = (header: string | null) => (header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null);

// 1) Sin pagar: el 402 debe cumplir x402 v2
const first = await fetch(url);
const required = decode(first.headers.get("payment-required"));
if (first.status !== 402 || !required) throw new Error(`Se esperaba 402 con PAYMENT-REQUIRED; llegó ${first.status}`);
const option = required.accepts?.[0];
const problems = [
  required.x402Version !== 2 && "x402Version ≠ 2",
  option?.scheme !== "exact" && "scheme ≠ exact",
  option?.network !== USDC[network].caip2 && `network ≠ ${USDC[network].caip2}`,
  option?.asset?.toLowerCase() !== USDC[network].asset.toLowerCase() && "asset no es el USDC de la red",
  !/^0x[0-9a-fA-F]{40}$/.test(option?.payTo ?? "") && "payTo inválido",
  !option?.extra?.name || !option?.extra?.version ? "faltan extra.name/version (dominio EIP-712)" : false,
].filter(Boolean);
console.log("402 recibido:", JSON.stringify({ network: option?.network, amount: option?.amount, asset: option?.asset, payTo: option?.payTo, extra: option?.extra }));
if (problems.length) throw new Error(`El 402 no cumple x402 v2: ${problems.join("; ")}`);
if (BigInt(option.amount) > max) throw new Error(`El servidor pide ${option.amount} (atómico), más que MAX_USDC`);

// 2) Pagar con el cliente estándar. El USDC de Fuji no es un "activo por defecto" de x402:
//    hay que permitirlo explícitamente (en mainnet, el USDC de Avalanche ya viene permitido).
const client = x402Client.fromConfig({
  schemes: [{ network: USDC[network].caip2, client: new ExactEvmScheme(account) }],
  spendControls: {
    allowedAssets: [{ network: USDC[network].caip2, asset: USDC[network].asset, maxAmountPerPayment: max.toString() }],
  },
});
const pay = wrapFetchWithPayment(fetch, client);
const res = await pay(url);
const settled = decode(res.headers.get("payment-response"));
console.log(`Pagador: ${account.address}`);
console.log(`Status:  ${res.status}`);
console.log("Pago:   ", JSON.stringify(settled));
if (res.status !== 200 || !settled?.success) throw new Error("El pago con @x402/fetch no se completó");
console.log("✅ @x402/fetch (sin SDK de Sekisho) pagó correctamente");
