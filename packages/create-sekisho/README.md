# create-sekisho

Start charging USDC per API call with [x402](https://x402.org) on Avalanche, in 5 minutes.

```bash
npm create @zero-two-labs/sekisho my-api -- --merchant 0xYourWallet
cd my-api
npm install
npm run dev
```

You get a [Hono](https://hono.dev) server with a paid endpoint (`GET /premium`), powered by [`@zero-two-labs/sekisho`](https://www.npmjs.com/package/@zero-two-labs/sekisho):

- Every payment settles into **your SplitVault** on Avalanche; the built-in distributor pays out 98.5% to your wallet and 1.5% to the platform, in batches.
- A **new operator key** is generated in `.env` (file mode `600`, never printed). It settles payments and pays gas; it has no permissions on the contracts. Send it a little AVAX.
- `npm run pay` pays your own endpoint like an agent would (402 → EIP-3009 signature → 200).

| Option | Default | |
| --- | --- | --- |
| `--merchant` | (asked if omitted) | Your wallet; receives 98.5% of every payment |
| `--network` | `avalancheFuji` | `avalanche` for mainnet (real USDC) |
| `--price` | `0.01` | USDC per call |

No dependencies; requires Node 20+ (the generated project needs Node 22+).
