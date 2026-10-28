# Sekisho demo API

A public, paid HTTP API on Avalanche. Each call costs USDC and is paid with [x402](https://x402.org) through [Sekisho](../../sdk): the payment settles into the seller's SplitVault and the built-in distributor splits it (98.5% seller, 1.5% platform).

| Endpoint | Price | Returns |
| --- | --- | --- |
| `GET /` | free | Service info: network, price, `payTo`, how to pay |
| `GET /health` | free | `{ "ok": true }` |
| `GET /v1/avalanche/snapshot` | `PRICE_USDC` (0.01 by default) | Latest block, gas price and the Sekisho factory config |

## Pay from an agent

```ts
import { createSekishoFetch } from "@zero-two-labs/sekisho";

const { fetch: pay } = createSekishoFetch({ account, network: "avalanche", maxPerPayment: "0.01" });
const res = await pay("https://api.sekisho.zerotwolabs.xyz/v1/avalanche/snapshot");
console.log(await res.json());
```

The paying wallet needs USDC on the same network; it only signs (no AVAX needed).

## Run it

```bash
cp .env.example .env   # NETWORK, OPERATOR_PRIVATE_KEY, MERCHANT_ADDRESS
npm install
npm run dev            # http://localhost:3000
```

| Variable | Meaning |
| --- | --- |
| `NETWORK` | `avalancheFuji` (default) or `avalanche` (mainnet, real USDC) |
| `OPERATOR_PRIVATE_KEY` | Hot key that settles payments and runs splits. Needs AVAX for gas; holds no role on the contracts. Use one only for this service. |
| `MERCHANT_ADDRESS` | Seller wallet that receives 98.5% of every payment |
| `PRICE_USDC` | Price per call (default `0.01`) |
| `DISTRIBUTE_*` | Distribution policy (see the SDK README) |
| `RATE_LIMIT_PER_MINUTE` | Requests per minute per IP (default 60) |

Docker: `docker build -t sekisho-demo-api .` — the image runs `node dist/index.js` as a non-root user with a `/health` check.
