# Sekisho demo API

A public, paid HTTP API on Avalanche. Each call costs USDC and is paid with [x402](https://x402.org) through [Sekisho](../../sdk): the payment settles into the seller's SplitVault and the built-in distributor splits it (98.5% seller, 1.5% platform).

| Endpoint | Price | Returns |
| --- | --- | --- |
| `GET /` | free | Service info: network, price, `payTo`, how to pay |
| `GET /health` | free | `{ "ok": true }` |
| `GET /v1/metrics` | free | Sekisho-wide on-chain metrics (payments, volume, vaults, splits), CORS open. Feeds [sekisho.zerotwolabs.xyz/metrics](https://sekisho.zerotwolabs.xyz/metrics/) |
| `GET /v1/avalanche/snapshot` | `PRICE_USDC` (0.01 by default) | Latest block, gas price and the Sekisho factory config |
| `POST /mcp` | — | MCP server (Streamable HTTP, stateless): tool `ping` (free) and `avalanche_snapshot` (`PRICE_USDC` per call) |

## Pay from an agent

```ts
import { createSekishoFetch } from "@zero-two-labs/sekisho";

const { fetch: pay } = createSekishoFetch({ account, network: "avalanche", maxPerPayment: "0.01" });
const res = await pay("https://sekisho-api.zerotwolabs.xyz/v1/avalanche/snapshot");
console.log(await res.json());
```

The paying wallet needs USDC on the same network; it only signs (no AVAX needed).

> **The demo is subsidized.** Each call costs the operator about $0.0025 in gas to settle (plus ~$0.002 per split, batched at 1 USDC), while the platform fee on 0.01 USDC is 0.00015 USDC. It exists to show the flow, not as a pricing reference: on Avalanche, a paid call covers its own gas from roughly $0.30 per call, or $0.17 with batched splits.

## Pay for an MCP tool

```ts
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSekishoMcpClient } from "@zero-two-labs/sekisho";

const client = createSekishoMcpClient({ account, network: "avalanche", maxPerPayment: "0.01", maxPerSession: "0.10" });
await client.connect(new StreamableHTTPClientTransport(new URL("https://sekisho-api.zerotwolabs.xyz/mcp")));
const result = await client.callTool("avalanche_snapshot", {});
console.log(result.content, result.paymentResponse?.transaction);
```

The client receives the payment requirement from the tool, signs within its limits and retries automatically. Generic MCP hosts without an x402-capable client can list the tools and call `ping`, but can't pay.

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
| `METRICS` | `on` (default) or `off` for `GET /v1/metrics` |
| `METRICS_OWN_WALLETS` | Comma-separated project wallets (tests); their payments are not counted as external. The demo merchant and operator are added automatically |
| `METRICS_SYNC_SECONDS` / `METRICS_MAX_RANGE` | Poll interval (60) and blocks per `eth_getLogs` (2048, halved automatically if the RPC refuses) |

### Metrics

`GET /v1/metrics` is computed from Avalanche event logs only, from the factory's deployment block: `VaultCreated` (factory), USDC `Transfer` into any vault, and `Distributed` (vaults). Nothing is stored: the service re-reads the chain on boot (the response says `"syncing": true` until the first pass ends) and then follows new blocks. A vault is counted once it is deployed; payments it received at its predicted address before that are recovered at that moment.

Docker: `docker build -t sekisho-demo-api .` — the image runs `node dist/index.js` as a non-root user with a `/health` check.
