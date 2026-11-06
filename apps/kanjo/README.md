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

## Stores

One Kanjō instance serves many stores. Each store has its own catalog, business profile and wallet, and its sales are paid into that wallet's own SplitVault. Nothing has to be deployed to add a store: the vault address is known in advance and the vault is created on its first split.

```bash
npm run store:create -- carniceria-don-pepe "Carnicería Don Pepe" 0xYourWallet perfil.json           # preview
npm run store:create -- carniceria-don-pepe "Carnicería Don Pepe" 0xYourWallet perfil.json --apply   # create
npm run catalog:import -- <url> --store carniceria-don-pepe                                          # its catalog
```

A store is created only if everything is valid, and nothing is saved otherwise: the id (3–40 lowercase letters, numbers and dashes, used in links), the name, the wallet (a real address; a mixed-case address whose checksum fails is rejected as a likely copy error) and the optional profile. The profile can also be added later with `npm run store:profile`.

How customers reach a store:

| Channel | How |
| --- | --- |
| WhatsApp | The customer sends `/tienda <id>`. Kanjō remembers the store for that customer and starts a fresh conversation. Customers who never chose one talk to the default store (`STORE_ID`). |
| Web voice | `/voice?store=<id>` |
| AI agents (MCP) | `stores` lists them; `menu`, `place_order` take a `store_id` |

## Business profile

Kanjō works for any kind of shop: the catalog says **what** it sells, and the business profile says **how**. Each store has one:

| Field | Example | Used for |
| --- | --- | --- |
| `businessType` | `cafeteria`, `abarrotes`, `tlapaleria`, `carniceria`, `otro` | How the agent introduces the store |
| `description` | "Carnicería de barrio: res, cerdo y pollo frescos." | Answering "what do you sell?" |
| `hours` | "Lunes a sábado, 7:00 a 15:00" | Opening hours |
| `fulfillment` | `pickup`, `delivery` or `both` | Whether the customer picks up or gets a delivery |
| `address` / `deliveryArea` | "Av. Juárez 123" / "Centro y Roma" | Where to pick up / where the store delivers |
| `prepMinutes` | `20` | "Ready in about 20 min" |
| `policies`, `tone` | "No refunds on cut meat" / "friendly, formal" | Rules and voice of the agent |

The agent can only state what the profile says. A field left empty reads as "not provided", and the agent answers that it will check with the store instead of making it up. After payment, the customer (WhatsApp) and the agent (MCP `pay_order`) get the same pickup or delivery line, for example *"Recógelo en Av. Juárez 123. Estará listo en unos 20 min."*

Profiles are validated before they are saved: an unknown business type, a misspelled field, delivery without a delivery area or pickup without an address are rejected with a plain explanation, and the previous profile stays untouched.

```bash
npm run store:profile                                  # list stores
npm run store:profile -- cafe-kanjo                    # show a profile and what is missing
npm run -s store:profile -- --example > perfil.json    # example to edit (-s keeps npm's header out of the file)
npm run store:profile -- cafe-kanjo perfil.json        # preview: validates and shows the changes
npm run store:profile -- cafe-kanjo perfil.json --apply
```

In the Docker image the same tools are `node dist/scripts/store-profile.js` and `node dist/scripts/store-create.js`.

## Channels

| Channel | How | Status |
| --- | --- | --- |
| WhatsApp | Meta WhatsApp Cloud API webhook (`/webhook`, signature checked with `X-Hub-Signature-256`) | Built, waiting for Meta verification |
| Terminal | `npm run chat` | For local testing |
| HTTP dev chat | `POST /dev/chat`, only when `DEV_CHAT_TOKEN` is set | Off in production |
| Web voice | `/voice`: speak to the agent in the browser, answers in voice (ElevenLabs) | `VOICE_WEB=off` in production |
| AI agents (MCP) | `/mcp`: an agent browses stores and menus, places an order and pays it with x402 | `MCP_CHANNEL=on` on Fuji |

## Features

- **Catalog from any URL with [Firecrawl](https://firecrawl.dev):** `npm run catalog:import -- <url>` extracts products, prices, sections and photos into a preview with a diff against the store; `npm run catalog:apply -- <id>` writes it (merge or replace). Prices in MXN are converted with `FX_MXN_PER_USDC` and rounded to cents. Demo menu: [`/demo/menu.html`](https://sekisho.zerotwolabs.xyz/demo/menu.html).
- **Voice with [ElevenLabs](https://elevenlabs.io):** speech-to-text for incoming voice notes and spoken replies (Ogg/Opus voice notes on WhatsApp, MP3 on the web). Spoken replies drop links, ids and formatting and read amounts out loud; a reply with a payment link always goes as text.
- **Safety:**
  - no overselling: stock is checked before charging, and a paid order without stock is flagged, never lost;
  - no double charges: a settlement lock per order and one row per transaction;
  - an inbox that survives restarts: no message is answered twice, and pending ones are picked up again after a crash;
  - an outbox with retries for notifications;
  - rate limits per IP and a 64 KB body limit.

## Buy through an AI agent (MCP)

With `MCP_CHANNEL=on`, Kanjō serves an MCP endpoint at `/mcp` (Streamable HTTP). Any agent can buy from any store in the instance:

| Tool | Cost | What it does |
| --- | --- | --- |
| `stores` | free | Stores you can buy from |
| `menu` | free | Products of a store: id, price in USDC, available stock |
| `place_order` | free | Creates an unpaid order and returns `order_id`, `token` and the total |
| `order_status` | free | Status of an order and its payment transaction |
| `pay_order` | **the order total** | Charges exactly the total with x402 into the store's SplitVault and marks the order paid |

`stores` and `menu` include the store's business profile (hours, pickup or delivery, prep time), and `pay_order` answers with the pickup or delivery line, so the agent does not promise what the store does not offer. `pay_order` uses the same checks as the web checkout: valid token, order still pending, stock available, one settlement at a time, and one payment row per transaction. A second payment is refused before it is charged. Orders placed by agents never trigger customer messages; the store still gets its notice. At most `MCP_MAX_PENDING` unpaid agent orders exist at once (default 20), and `/mcp` is rate limited per IP (`MCP_PER_MINUTE`, default 60).

From OpenCode, Claude Code or Codex, use [`@zero-two-labs/sekisho-mcp`](../../packages/sekisho-mcp) with `SEKISHO_MCP_URL=https://kanjo.zerotwolabs.xyz/mcp`. Raise its per-call cap to cover an order (for example `SEKISHO_MAX_PER_CALL=5`): its 0.01 USDC default would refuse a real order, on purpose.

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
| `STORE_ID`, `STORE_NAME` | no | Store seeded on start, and the default store for customers who have not chosen one |
| `DISTRIBUTE_*` | no | Split policy (batch by default) |
| `WHATSAPP_*`, `NOTIFY_CHANNEL`, `MERCHANT_WA_ID` | for WhatsApp | Cloud API credentials and where notices go |
| `FIRECRAWL_API_KEY`, `FX_MXN_PER_USDC` | for catalog import | Firecrawl key and MXN rate |
| `ELEVENLABS_*`, `VOICE_WEB`, `VOICE_REPLIES` | for voice | ElevenLabs key and voice, and which channels speak |
| `MCP_CHANNEL`, `MCP_MAX_PENDING`, `MCP_PER_MINUTE` | for agents | Turns on `/mcp` and its limits |

## Scripts

| Command | What it does |
| --- | --- |
| `npm test` | Payment safety, split policy, security, inbox, catalog/voice, MCP, business profile and multi-store checks |
| `npm run store:create` | Preview and create a store (id, name, wallet, optional profile) |
| `npm run store:profile` | Show, preview and save a store's business profile |
| `npm run typecheck` | TypeScript check |
| `npm run db:check` | Runs a test order through the store database (catalog, order, payment) |
| `npm run pay:check` | Shows the payment quote (vault, amount, network) of the latest pending order |
| `npm run test:webhook` | Simulates a signed WhatsApp webhook |
| `npm run voice:check` | Checks the ElevenLabs configuration |
| `npm run distribute` | Runs the split policy once (`--force` splits whatever is pending) |
| `npm run gas:report` | Live gas cost of settling and splitting |
| `npm run catalog:import -- <url> [--store <id>]` / `catalog:apply -- <id>` | Catalog from a web page |

## Deploy

The [`Dockerfile`](Dockerfile) builds a production image that runs as an unprivileged user, seeds the store on start and checks its own health on `/`. Mount a volume on `/app/data`: the SQLite database lives there. The live instance runs on Dokploy behind a Cloudflare tunnel at `kanjo.zerotwolabs.xyz`.

## Limits

- **Paying needs a browser wallet.** The checkout works with an injected wallet (for example MetaMask or Core on desktop, or the wallet's in-app browser on mobile). Paying from any phone without a wallet is the main item before mainnet.
- **Store notices go to one number.** Paid-order notices for every store go to `MERCHANT_WA_ID`, with the store name in the message. Each store gets its own contact with the Telegram channel.
- **One replica.** The settlement lock and rate limits live in the process, so Kanjō runs as a single instance.
- **Testnet only** for now: orders are paid with Fuji USDC.
