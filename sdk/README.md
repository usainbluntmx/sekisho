# Sekisho 関所

**x402 payments with automatic revenue split on Avalanche.**

Sekisho turns any API or MCP tool into a paid endpoint that AI agents can pay for with USDC, using the [x402](https://x402.org) protocol. Every payment lands in the seller's on-chain **SplitVault**, which distributes the platform fee and the seller's share automatically.

> Status: `v0.1.2` — Avalanche Fuji testnet.

## Install

```bash
npm install @zero-two-labs/sekisho viem
```

## How it works

```
Agent ──(x402, USDC)──▶ Seller's SplitVault ──distribute()──┬──▶ Platform fee
                              ▲                              └──▶ Seller
                              │
                     SplitVaultFactory (one vault per seller, deterministic address)
```

- Each seller gets a **deterministic vault address** (`payTo`) — payments can arrive before the vault is deployed.
- `distribute()` is permissionless: funds can only go to the seller and the platform treasury.
- Platform fee is hard-capped at **10%** in the contract.

## Usage

### 1. Read vaults and split payments

```ts
import { createSekishoClient } from "@zero-two-labs/sekisho";

const sekisho = createSekishoClient({ network: "avalancheFuji" });

const payTo = await sekisho.getPayTo("0xSeller...");
const { total, fee, merchantAmount } = await sekisho.pending("0xSeller...");
```

### 2. Sell an HTTP endpoint (Hono example)

```ts
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  createSekishoClient,
  createPaymentOption,
  createSekishoFacilitator,
  toFacilitatorClient,
} from "@zero-two-labs/sekisho";

const sekisho = createSekishoClient({ network: "avalancheFuji" });
const option = await createPaymentOption(sekisho, { merchant: "0xSeller...", price: "0.01" });

const facilitator = createSekishoFacilitator({ account: facilitatorAccount });
const server = new x402ResourceServer(toFacilitatorClient(facilitator))
  .register(option.network, new ExactEvmScheme());

app.use(paymentMiddleware({ "GET /premium": { accepts: [option] } }, server));
```

### 3. Pay as an agent (with spend limits)

```ts
import { createSekishoFetch } from "@zero-two-labs/sekisho";

const { fetch: payFetch } = createSekishoFetch({ account, maxPerPayment: "0.05" });
const res = await payFetch("https://api.example.com/premium");
```

### 4. Paid MCP tools

```ts
import { createSekishoMcpPaywall, createSekishoMcpClient } from "@zero-two-labs/sekisho";

// Server
const paid = await createSekishoMcpPaywall({
  sekisho, facilitator, merchant: "0xSeller...", price: "0.01",
  onSettled: () => sekisho.distribute("0xSeller..."),
});
mcpServer.tool("premium_insight", "Costs 0.01 USDC", { topic: z.string() }, paid(handler));

// Agent
const client = createSekishoMcpClient({ account, maxPerPayment: "0.05" });
const result = await client.callTool("premium_insight", { topic: "Avalanche" });
```

## RPC

By default the SDK uses Avalanche's official public RPC with publicnode as automatic backup: if one endpoint fails (403, 429, 5xx or timeout), requests move to the next one. For production, pass your own RPC (or a list); the public endpoints stay as backup.

```ts
const sekisho = createSekishoClient({
  network: "avalancheFuji",
  rpcUrl: process.env.AVALANCHE_FUJI_RPC_URL, // optional: string or string[]
});
```

## Deployments

| Network | SplitVaultFactory | USDC |
| --- | --- | --- |
| Avalanche Fuji (`eip155:43113`) | [`0xA1967201adD1Ac57d1c72D04Ca4d9159B98C8C5D`](https://testnet.snowtrace.io/address/0xA1967201adD1Ac57d1c72D04Ca4d9159B98C8C5D) | `0x5425890298aed601595a70AB815c96711a31Bc65` |

## License

MIT © Zero Two Labs