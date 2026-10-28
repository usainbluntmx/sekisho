# Sekisho 関所 · Kanjō 勘定

**AI agents that sell — and get paid.** x402 payments on Avalanche with an on-chain revenue split, run in batches by a built-in distributor.

- **Sekisho** (関所, *checkpoint*): on-chain payment layer + SDK. Any API or MCP tool can charge USDC via [x402](https://x402.org); every payment lands in the seller's **SplitVault**, which splits the platform fee and the seller's share.
- **Kanjō** (勘定, *the bill*): an AI sales agent for small businesses. It chats with customers, builds orders and collects payment through Sekisho.

> **Status:** live on **Avalanche C-Chain mainnet** (Sekisho contracts and SDK). Kanjō runs on Fuji testnet. See [SECURITY.md](SECURITY.md).
> Website: https://sekisho.zerotwolabs.xyz · SDK: [`@zero-two-labs/sekisho`](https://www.npmjs.com/package/@zero-two-labs/sekisho)

## Repository

| Layer | Path | What it is |
| --- | --- | --- |
| Contracts | [`backend/`](backend) | `SplitVault` + `SplitVaultFactory` (Solidity, Hardhat, 40 tests) |
| SDK | [`sdk/`](sdk) | x402 helpers for sellers, paying agents, self-facilitation and paid MCP tools |
| App | [`apps/kanjo/`](apps/kanjo) | AI sales agent (Claude) + x402 checkout, deployed with Docker |
| Website | [`apps/web/`](apps/web) | Landing page (Astro) at sekisho.zerotwolabs.xyz |
| Demo API | [`apps/demo-api/`](apps/demo-api) | Public paid API on mainnet (x402, 0.01 USDC per call) at [sekisho-api.zerotwolabs.xyz](https://sekisho-api.zerotwolabs.xyz) |

## How a payment flows

```
Customer ──chat──▶ Kanjō agent (Claude) ──▶ order + payment link
   │
   └─ signs EIP-3009 authorization (gasless) ──▶ Kanjō facilitator settles USDC
                                                     │
                                                     ▼
                                     Merchant's SplitVault (deterministic address)
                                                     │  distribute() — batched
                                     ┌───────────────┴───────────────┐
                                     ▼                               ▼
                             Treasury (1.5%)                  Merchant (98.5%)
```

## Deployments

**Avalanche C-Chain mainnet** (`eip155:43114`)

| Contract / role | Address |
| --- | --- |
| `SplitVaultFactory` (v3) | [`0xeB43A8b678E0b4ee7f11bd2867bC8B5EaC9444A6`](https://snowtrace.io/address/0xeB43A8b678E0b4ee7f11bd2867bC8B5EaC9444A6) |
| `SplitVault` (v3 implementation) | [`0x24A48f2cCFaaC60918F81c25B56380A3610F75F5`](https://snowtrace.io/address/0x24A48f2cCFaaC60918F81c25B56380A3610F75F5) |
| Owner and treasury (Safe 2-of-3) | [`0xbABB7B7C35438B2Ab646da3C820859062ACEA3Dc`](https://snowtrace.io/address/0xbABB7B7C35438B2Ab646da3C820859062ACEA3Dc) |
| USDC (Circle) | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |

**First x402 payment on mainnet** (2026-10-28), through the [demo API](apps/demo-api): an agent paid 0.01 USDC for `GET /v1/avalanche/snapshot`, the server settled it into the seller's vault, and the SDK's distributor split it automatically.

| Step | Transaction |
| --- | --- |
| Settlement (`transferWithAuthorization`, payer → vault `0xBF15…8e36`) | [`0xadb28eed…91c1`](https://snowtrace.io/tx/0xadb28eeda068a171bd1cd348e3113f479952ea2eab8c4fc9d956b130625591c1) |
| Vault deployment (`createVault`) | [`0x19bd48d6…1f5a`](https://snowtrace.io/tx/0x19bd48d6a5d6160ca859776d906d1a8c9f8550aa4133eabaa8f8cd6561981f5a) |
| Split (`distribute`): 0.00985 USDC to the seller, 0.00015 USDC to the Safe | [`0x3d4f388b…612b`](https://snowtrace.io/tx/0x3d4f388b9ec516617713197fdb4355379cc5a90fb88563f558747630ac9e612b) |

**Avalanche Fuji testnet** (`eip155:43113`)

| Contract / role | Address |
| --- | --- |
| `SplitVaultFactory` (v3) | [`0x1fC9C58DfbBDa2d0508b12800859e54f4f3519Ab`](https://testnet.snowtrace.io/address/0x1fC9C58DfbBDa2d0508b12800859e54f4f3519Ab) |
| `SplitVault` (v3 implementation) | [`0xD504A30e90A5EEa3d5fd26B588c9854e31819a3C`](https://testnet.snowtrace.io/address/0xD504A30e90A5EEa3d5fd26B588c9854e31819a3C) |
| Owner | `0xb7345347a7FCAa1D4A411e843D8939016737F3b3` |
| Treasury | `0x06584d9FF65a2cB110022858A9540d903258298A` |
| USDC (Circle) | `0x5425890298aed601595a70AB815c96711a31Bc65` |

Deprecated factories on Fuji: v2 [`0x198F21AF47221bb06dAAf8e4F5eB46F9ba388807`](https://testnet.snowtrace.io/address/0x198F21AF47221bb06dAAf8e4F5eB46F9ba388807) (no fee delay, SDK 0.2.x) and v1 [`0xA1967201adD1Ac57d1c72D04Ca4d9159B98C8C5D`](https://testnet.snowtrace.io/address/0xA1967201adD1Ac57d1c72D04Ca4d9159B98C8C5D) (no merchant rotation, SDK ≤ 0.1.5).

## Security model

- **Fee hard cap and 7-day delay:** `MAX_FEE_BPS = 1000` (10%) is enforced in the contract; not even the owner can exceed it. Every fee change is scheduled and applies 7 days later (`FEE_CHANGE_DELAY`). The fee is applied when funds are split, not when they are charged: calling `distribute()` before the deadline splits pending funds at the old rate, and the SDK's distributor does it automatically when it sees a scheduled increase. Current fee: 1.5%.
- **Permissionless, fixed-destination splits:** anyone can call `distribute()`, but funds can only go to the treasury and the merchant.
- **No withdraw function:** everything that enters a vault can only leave through `distribute()`. Vaults reject native AVAX.
- **Two-step merchant rotation:** only the current merchant can propose a new payout address and only that address can accept; anything pending is paid to the previous address first.
- **Separated keys:** on mainnet, owner and treasury are a Safe 2-of-3 multisig; on Fuji they are two separate single-key wallets. The server's operator key settles payments and triggers splits but holds **no permissions** on the contracts.
- **No lost payments:** a settled payment is always recorded, even if stock ran out (the order is flagged for refund). A per-order lock prevents double settlement; WhatsApp webhooks are deduplicated by message id.

## Quickstart

**Contracts**

```bash
cd backend && npm install && npx hardhat test
```

**SDK**

```bash
npm install @zero-two-labs/sekisho viem
```

See [`sdk/README.md`](sdk/README.md) for seller, agent, facilitator, MCP and distributor (keeper) examples.

**Kanjō** (no WhatsApp account needed for local testing)

```bash
cd apps/kanjo
cp .env.example .env      # fill MERCHANT_ADDRESS, ANTHROPIC_API_KEY, OPERATOR_PRIVATE_KEY
npm install
npm run seed              # demo store and catalog
npm run chat              # talk to the agent in your terminal
npm run dev               # server + checkout at http://localhost:3000
```

Checks: `npm run test:safety` · `npm run test:distribution` · `npm run test:webhook` · `npm run gas:report`

## Economics (measured October 2026)

With mainnet gas at 2.5 nAVAX and AVAX ≈ $9.5:

| Operation | Gas | Cost |
| --- | --- | --- |
| Settlement (`transferWithAuthorization`) | ~102.8k | ~$0.0025 |
| Split (`distribute`) | ~92.9k | ~$0.0023 |

With a 1.5% fee, the minimum viable ticket is **~$0.30** splitting every order and **~$0.17** splitting in batches. That is why the SDK's distributor and Kanjō split in batches (≥ 5 USDC, or every 24 h once at least 0.25 USDC is pending). Run `npm run gas:report` in `apps/kanjo` for live numbers.

## Roadmap

- Mobile checkout from WhatsApp's in-app browser (WalletConnect or embedded wallets)
- Fiat on-ramp (SPEI → USDC into the same vault) through a regulated provider
- `batch-settlement` x402 scheme for sub-cent MCP micropayments

## License

[MIT](LICENSE) © Zero Two Labs