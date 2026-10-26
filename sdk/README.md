# Sekisho 関所

**x402 payments with automatic revenue split on Avalanche.**

Sekisho turns any API or MCP tool into a paid endpoint that AI agents can pay for with USDC, using the [x402](https://x402.org) protocol. Every payment lands in the seller's on-chain **SplitVault**, which distributes the platform fee and the seller's share automatically.

> Status: `v0.2.0` — Avalanche Fuji testnet.

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
- Vaults have **no withdraw function**: everything that enters can only leave through `distribute()`, to the treasury and the seller, in the contract's proportion.
- Sellers can **rotate** the address that receives their payouts (two-step, see below).

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

## Merchant rotation

A seller can move their vault to a new address in two steps. Only the current seller can propose, and only the proposed address can accept, so a typo never redirects payouts. Anything pending in the vault is paid to the **previous** address before the switch.

```ts
// 1) Current seller
const seller = createSekishoClient({ network: "avalancheFuji", account: currentSellerAccount });
await seller.proposeMerchant("0xNewAddress...");

// 2) New address
const next = createSekishoClient({ network: "avalancheFuji", account: newAddressAccount });
await next.acceptMerchant(await next.getPayTo(currentSellerAccount.address));
```

After the rotation, `getPayTo(newAddress)` returns the same vault, and `getPayTo(oldAddress)` throws: charging the old address would pay someone else.

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
| Avalanche Fuji (`eip155:43113`) | [`0x198F21AF47221bb06dAAf8e4F5eB46F9ba388807`](https://testnet.snowtrace.io/address/0x198F21AF47221bb06dAAf8e4F5eB46F9ba388807) (v2) | `0x5425890298aed601595a70AB815c96711a31Bc65` |

The v1 factory (`0xA1967201adD1Ac57d1c72D04Ca4d9159B98C8C5D`) is deprecated and used by SDK versions up to 0.1.5.

## License

MIT © Zero Two Labs