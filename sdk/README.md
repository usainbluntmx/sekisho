# Sekisho 関所

**x402 payments on Avalanche with an on-chain revenue split and a built-in distributor.**

Sekisho turns any API or MCP tool into a paid endpoint that AI agents can pay for with USDC, using the [x402](https://x402.org) protocol. Every payment lands in the seller's on-chain **SplitVault**, which can only pay out the platform fee and the seller's share. The SDK's **distributor** triggers those splits for you, in batches, so gas doesn't eat small payments.

> Status: `v0.5.0` — live on **Avalanche C-Chain mainnet** and Fuji testnet. Contracts are verified, tested and statically analyzed; see [SECURITY.md](https://github.com/usainbluntmx/sekisho/blob/main/SECURITY.md).

## Install

```bash
npm install @zero-two-labs/sekisho viem
```

## Networks

| `network` | Chain | Use it for |
| --- | --- | --- |
| `"avalancheFuji"` (default) | Avalanche Fuji testnet (`eip155:43113`) | Development and tests, with test USDC |
| `"avalanche"` | Avalanche C-Chain mainnet (`eip155:43114`) | Real payments in USDC |

```ts
const sekisho = createSekishoClient({ network: "avalanche" }); // mainnet
```

The default stays on Fuji so nothing touches real funds unless you ask for mainnet explicitly.

## How it works

```
Agent ──(x402, USDC)──▶ Seller's SplitVault ──distribute()──┬──▶ Platform fee
                              ▲                              └──▶ Seller
                              │
                     SplitVaultFactory (one vault per seller, deterministic address)
```

- Each seller gets a **deterministic vault address** (`payTo`) — payments can arrive before the vault is deployed.
- `distribute()` is permissionless: funds can only go to the seller and the platform treasury. Someone has to call it (and pay its gas): the SDK's distributor does it automatically (see below).
- Platform fee is hard-capped at **10%** in the contract, and **every fee change takes 7 days** to apply (see below).
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
  createSekishoDistributor,
  toFacilitatorClient,
} from "@zero-two-labs/sekisho";

// The operator key settles payments and runs splits: it needs AVAX for gas, and has no permissions on the contracts
const sekisho = createSekishoClient({ network: "avalancheFuji", account: operator });
const option = await createPaymentOption(sekisho, { merchant: "0xSeller...", price: "0.01" });

const facilitator = createSekishoFacilitator({ account: operator });
const server = new x402ResourceServer(toFacilitatorClient(facilitator))
  .register(option.network, new ExactEvmScheme());

// Split automatically: after each payment and every 15 min, following the policy below
const distributor = createSekishoDistributor({ sekisho, merchants: ["0xSeller..."] });
server.onAfterSettle(async () => {
  distributor.notePayment("0xSeller...");
  void distributor.check(); // the response doesn't wait for the split
});
distributor.start();

app.use(paymentMiddleware({ "GET /premium": { accepts: [option] } }, server));
```

Full example: [`examples/seller-server.ts`](examples/seller-server.ts).

### 3. Pay as an agent (with spend limits)

```ts
import { createSekishoFetch } from "@zero-two-labs/sekisho";

const { fetch: payFetch } = createSekishoFetch({
  account,
  maxPerPayment: "0.05", // per request
  maxPerSession: "2", // optional: total for this client's lifetime
  maxPerDay: "5", // optional: total in any 24-hour window
});
const res = await payFetch("https://api.example.com/premium");
```

Over a limit, the agent refuses to sign and the request fails with an explicit error. A signed payment counts toward the limits even if the server never settles it.

### 4. Paid MCP tools

```ts
import { createSekishoMcpPaywall, createSekishoMcpClient } from "@zero-two-labs/sekisho";

// Server
const paid = await createSekishoMcpPaywall({
  sekisho, facilitator, merchant: "0xSeller...", price: "0.01",
  distributor, // createSekishoDistributor(...): notified on every settled call
});
mcpServer.tool("premium_insight", "Costs 0.01 USDC", { topic: z.string() }, paid(handler));

// Agent
const client = createSekishoMcpClient({ account, maxPerPayment: "0.05", maxPerSession: "0.50" });
const result = await client.callTool("premium_insight", { topic: "Avalanche" });
```

## Automatic distribution

Each `distribute()` costs gas (~93k, about $0.002 on mainnet in October 2026), so splitting every 0.01 USDC payment would cost more than the payment. `createSekishoDistributor` splits in batches:

| Reason | Splits when | Default |
| --- | --- | --- |
| `threshold` | Pending reaches `minUsdc` | 5 USDC |
| `max_age` | The oldest pending payment is `maxHours` old and pending ≥ `ageMinUsdc` | 24 h, 0.25 USDC |
| `fee_change` | A fee **increase** is scheduled, applies within `feeChangeHours`, and pending ≥ `ageMinUsdc` | 48 h |
| `forced` | You call `check({ force: true })` | — |

`ageMinUsdc` is a floor: below it, nothing is split automatically, because gas would cost more than the amount. Every value can be changed through `policy`.

```ts
const distributor = createSekishoDistributor({
  sekisho, // client with an account that has AVAX for gas
  merchants: ["0xSeller1...", "0xSeller2..."], // or an async function (e.g. a DB query)
  policy: { minUsdc: "10" }, // optional
  intervalMinutes: 15, // optional
  onDistributed: ({ merchant, tx, total, fee, reason }) => { /* record it */ },
});
distributor.start();
```

The age of pending payments is tracked in memory. After a restart it counts from the first check that finds a balance, so a split can come later than planned, never earlier.

**Standalone keeper.** `distribute()` is permissionless: any key with AVAX can run the splits for one or many sellers, separate from the server that charges. See [`examples/keeper.ts`](examples/keeper.ts) (`--once` runs a single check, for cron).

## Fee changes

The platform fee can only change through a scheduled change that applies **7 days later** (`FEE_CHANGE_DELAY`, fixed in the contract). The fee is applied when funds are **split**, not when they are charged: anything still pending when the change applies is split at the new rate. To split at the old rate, call `distribute()` before the deadline; the distributor does it automatically for a scheduled increase (`fee_change`).

```ts
const { feeBps, feeChange } = await sekisho.getConfig();
// feeChange: null, or { feeBps, effectiveAt } for a scheduled change (also: sekisho.getFeeChange())
```

The treasury address can be changed by the owner without delay; that only affects where the platform fee goes (max 10%), never the seller's share.

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

If the new address's own (not yet deployed) vault address already holds funds, `acceptMerchant` reverts with `CounterfactualFunds`, so those funds aren't stranded. Rotate to a different address in that case.

## Examples

Run them from `sdk/` with a `.env` based on [`.env.example`](.env.example). They use Fuji unless you set `SEKISHO_NETWORK=avalanche`.

| Command | What it does |
| --- | --- |
| `npm run example:read` | Reads the factory config and a seller's vault |
| `npm run example:seller` | HTTP endpoint that charges 0.01 USDC and splits automatically |
| `npm run example:agent` | Agent that pays that endpoint and waits for the split |
| `npm run example:mcp` | Agent that pays an MCP tool (starts `examples/mcp-server.ts`) |
| `npm run example:keeper` | Standalone distributor for one or many sellers |
| `npm run example:inspect -- 0xhash …` | Reads transactions on-chain: function, USDC transfers and Sekisho events |

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
| Avalanche C-Chain (`eip155:43114`) | [`0xeB43A8b678E0b4ee7f11bd2867bC8B5EaC9444A6`](https://snowtrace.io/address/0xeB43A8b678E0b4ee7f11bd2867bC8B5EaC9444A6) (v3) | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |
| Avalanche Fuji (`eip155:43113`) | [`0x1fC9C58DfbBDa2d0508b12800859e54f4f3519Ab`](https://testnet.snowtrace.io/address/0x1fC9C58DfbBDa2d0508b12800859e54f4f3519Ab) (v3) | `0x5425890298aed601595a70AB815c96711a31Bc65` |

On mainnet, the factory owner and the platform treasury are a [Safe](https://safe.global) 2-of-3 multisig (`0xbABB7B7C35438B2Ab646da3C820859062ACEA3Dc`).

Deprecated factories on Fuji: v2 `0x198F21AF47221bb06dAAf8e4F5eB46F9ba388807` (SDK 0.2.x) and v1 `0xA1967201adD1Ac57d1c72D04Ca4d9159B98C8C5D` (SDK ≤ 0.1.5).

## License

MIT © Zero Two Labs