# Kanjō 勘定

An AI sales agent for small businesses. It talks to customers, answers from the store's catalog, builds the order and sends a payment link. The customer pays in USDC and the money goes to the store's SplitVault through [Sekisho](../../README.md).

> **Status:** runs on **Avalanche Fuji (testnet)**. The WhatsApp channel is built and waiting for Meta's business verification; the web voice channel (`/voice`) is off in production. Mainnet needs a way to pay without a browser wallet (see [Limits](#limits)).

## How it works

```
Customer ──message──▶ Kanjō agent (Claude) ──tools──▶ catalog_list · order_create · order_status
                              │
                              └─▶ payment link  /pay/<order>?t=<token>
                                        │
Customer's wallet signs EIP-3009 (no gas) ─▶ POST /api/pay (x402)
                                        │
                     Kanjō operator settles USDC ─▶ store's SplitVault ─▶ order paid, store and customer notified
                                        │
                     distributor splits in batches ─▶ store wallet + 1.5 % platform fee (Safe)
```

- **Agent:** Claude through the Anthropic API, with three tools: `catalog_list`, `order_create` and `order_status`. Products, prices and stock come from the store database through those tools.
- **Payment link:** each order gets a random 128-bit token. Without it, `/pay/<order>` returns 404.
- **Checkout:** a page that asks the customer's wallet for one EIP-3009 signature. The operator key submits it and pays the gas; the customer only needs USDC.
- **Split:** USDC lands in the store's SplitVault. The [SDK distributor](../../sdk/README.md) splits in batches (≥ 5 USDC, or after 24 h once at least 0.25 USDC is pending), so gas stays below the fee.

## Channels

| Channel | How | Status |
| --- | --- | --- |
| WhatsApp | Meta WhatsApp Cloud API webhook (`/webhook`, signature checked with `X-Hub-Signature-256`) | Built, waiting for Meta verification |
| Terminal | `npm run chat` | For local testing |
| HTTP dev chat | `POST /dev/chat`, only when `DEV_CHAT_TOKEN` is set | Off in production |
| Web voice | `/voice`: speak to the agent in the browser, answers in voice (ElevenLabs) | `VOICE_WEB=off` in production |

## Features

- **Catalog from any URL with [Firecrawl](https://firecrawl.dev):** `npm run catalog:import -- <url>` extracts products, prices, sections and photos into a preview with a diff against the store; `npm run catalog:apply -- <id>` writes it (merge or replace). Prices in MXN are converted with `FX_MXN_PER_USDC` and rounded to cents. Demo menu: [`/demo/menu.html`](https://sekisho.zerotwolabs.xyz/demo/menu.html).
- **Voice with [ElevenLabs](https://elevenlabs.io):** speech-to-text for incoming voice notes and spoken replies (Ogg/Opus voice notes on WhatsApp, MP3 on the web). Spoken replies drop links, ids and formatting and read amounts out loud; a reply with a payment link always goes as text.
- **Safety:**
  - no overselling: stock is checked before charging, and a paid order without stock is flagged, never lost;
  - no double charges: a settlement lock per order and one row per transaction;
  - an inbox that survives restarts: no message is answered twice, and pending ones are picked up again after a crash;
  - an outbox with retries for notifications;
  - rate limits per IP and a 64 KB body limit.

## Run it locally

No WhatsApp account is needed.

```bash
cd apps/kanjo
cp .env.example .env      # fill MERCHANT_ADDRESS, ANTHROPIC_API_KEY, OPERATOR_PRIVATE_KEY, PUBLIC_BASE_URL
npm install
npm run seed              # demo store "Café Kanjō" and its catalog
npm run chat              # talk to the agent in your terminal
npm run dev               # server + checkout at http://localhost:3000
```

The operator key needs a little Fuji AVAX for gas (it settles payments and runs splits; it has no role on the contracts). To pay an order you need a browser wallet with Fuji USDC from [faucet.circle.com](https://faucet.circle.com).

## Configuration

Every variable is documented in [`.env.example`](.env.example). The service checks them at startup and stops with the full list of problems.

| Variable | Required | Meaning |
| --- | --- | --- |
| `MERCHANT_ADDRESS` | yes | Store wallet, owner of the SplitVault |
| `OPERATOR_PRIVATE_KEY` | yes | Hot key that settles and splits. Needs AVAX |
| `ANTHROPIC_API_KEY` | yes | Claude API key for the agent |
| `PUBLIC_BASE_URL` | yes | Public URL used in payment links |
| `NETWORK` | no | `avalancheFuji` (default) or `avalanche` |
| `STORE_ID`, `STORE_NAME` | no | Store seeded on start |
| `DISTRIBUTE_*` | no | Split policy (batch by default) |
| `WHATSAPP_*`, `NOTIFY_CHANNEL`, `MERCHANT_WA_ID` | for WhatsApp | Cloud API credentials and where notices go |
| `FIRECRAWL_API_KEY`, `FX_MXN_PER_USDC` | for catalog import | Firecrawl key and MXN rate |
| `ELEVENLABS_*`, `VOICE_WEB`, `VOICE_REPLIES` | for voice | ElevenLabs key and voice, and which channels speak |

## Scripts

| Command | What it does |
| --- | --- |
| `npm test` | Payment safety, split policy, security, inbox and catalog/voice checks |
| `npm run typecheck` | TypeScript check |
| `npm run db:check` | Runs a test order through the store database (catalog, order, payment) |
| `npm run pay:check` | Shows the payment quote (vault, amount, network) of the latest pending order |
| `npm run test:webhook` | Simulates a signed WhatsApp webhook |
| `npm run voice:check` | Checks the ElevenLabs configuration |
| `npm run distribute` | Runs the split policy once (`--force` splits whatever is pending) |
| `npm run gas:report` | Live gas cost of settling and splitting |
| `npm run catalog:import -- <url>` / `catalog:apply -- <id>` | Catalog from a web page |

## Deploy

The [`Dockerfile`](Dockerfile) builds a production image that runs as an unprivileged user, seeds the store on start and checks its own health on `/`. Mount a volume on `/app/data`: the SQLite database lives there. The live instance runs on Dokploy behind a Cloudflare tunnel at `kanjo.zerotwolabs.xyz`.

## Limits

- **Paying needs a browser wallet.** The checkout works with an injected wallet (for example MetaMask or Core on desktop, or the wallet's in-app browser on mobile). Paying from any phone without a wallet is the main item before mainnet.
- **One replica.** The settlement lock and rate limits live in the process, so Kanjō runs as a single instance.
- **Testnet only** for now: orders are paid with Fuji USDC.
