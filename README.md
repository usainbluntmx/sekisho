# Sekisho 関所 · Kanjō 勘定

**AI agents that sell — and get paid.** x402 payments with automatic revenue split on Avalanche.

- **Sekisho** (関所, *checkpoint*): on-chain payment layer + SDK. Any API or MCP tool can charge USDC via [x402](https://x402.org); every payment lands in the seller's **SplitVault**, which splits the platform fee and the seller's share.
- **Kanjō** (勘定, *the bill*): an AI sales agent for small businesses. It chats with customers, builds orders and collects payment through Sekisho.

> **Status:** testnet (Avalanche Fuji). Contracts are **not audited**. Do not use with real funds.
> Live demo: https://kanjo.zerotwolabs.xyz · SDK: [`@zero-two-labs/sekisho`](https://www.npmjs.com/package/@zero-two-labs/sekisho)

## Repository

| Layer | Path | What it is |
| --- | --- | --- |
| Contracts | [`backend/`](backend) | `SplitVault` + `SplitVaultFactory` (Solidity, Hardhat, 17 tests) |
| SDK | [`sdk/`](sdk) | x402 helpers for sellers, paying agents, self-facilitation and paid MCP tools |
| App | [`apps/kanjo/`](apps/kanjo) | AI sales agent (Claude) + x402 checkout, deployed with Docker |

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

## Deployments — Avalanche Fuji (`eip155:43113`)

| Contract / role | Address |
| --- | --- |
| `SplitVaultFactory` | [`0xA1967201adD1Ac57d1c72D04Ca4d9159B98C8C5D`](https://testnet.snowtrace.io/address/0xA1967201adD1Ac57d1c72D04Ca4d9159B98C8C5D) |
| `SplitVault` (implementation) | [`0xA41b2f9A5dD725ECe6873c586b04c8Ef21921834`](https://testnet.snowtrace.io/address/0xA41b2f9A5dD725ECe6873c586b04c8Ef21921834) |
| Owner | `0xb7345347a7FCAa1D4A411e843D8939016737F3b3` |
| Treasury | `0x06584d9FF65a2cB110022858A9540d903258298A` |
| USDC (Circle) | `0x5425890298aed601595a70AB815c96711a31Bc65` |

## Security model

- **Fee hard cap:** `MAX_FEE_BPS = 1000` (10%) is enforced in the contract; not even the owner can exceed it. Current fee: 1.5%.
- **Permissionless, fixed-destination splits:** anyone can call `distribute()`, but funds can only go to the treasury and the merchant.
- **Separated keys:** owner and treasury are cold wallets; the server's operator key settles payments and triggers splits but holds **no permissions** on the contracts.
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

See [`sdk/README.md`](sdk/README.md) for seller, agent, facilitator and MCP examples.

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

With a 1.5% fee, the minimum viable ticket is **~$0.30** splitting every order and **~$0.17** splitting in batches. That is why Kanjō splits in batches (≥ 5 USDC or every 24 h). Run `npm run gas:report` in `apps/kanjo` for live numbers.

## Roadmap

- Mobile checkout from WhatsApp's in-app browser (WalletConnect or embedded wallets)
- Fiat on-ramp (SPEI → USDC into the same vault) through a regulated provider
- Merchant address rotation (contracts v2)
- `batch-settlement` x402 scheme for sub-cent MCP micropayments
- Mainnet with a multisig owner

## License

[MIT](LICENSE) © Zero Two Labs