# x402 interoperability

Sekisho endpoints speak standard x402 v2 (`exact` scheme, EIP-3009 on USDC). These clients pay a Sekisho endpoint **without the Sekisho SDK**, so we know any x402 client can buy from a Sekisho seller:

| Client | Path | Package |
| --- | --- | --- |
| Node, plain `@x402/fetch` | [`node/pay.ts`](node/pay.ts) | `@x402/core`, `@x402/evm`, `@x402/fetch` |
| Python | [`python/pay.py`](python/pay.py) | [`x402`](https://pypi.org/project/x402/) (official) |

Each client first checks that the `402` follows x402 v2 (version, scheme, network, USDC asset, `payTo`, EIP-712 domain in `extra`), refuses to pay more than `MAX_USDC` (default 0.01), then pays and checks the `PAYMENT-RESPONSE`.

## Without a chain (what CI runs)

```bash
(cd ../apps/demo-api && npm run interop:server)   # demo API on http://127.0.0.1:4402, strict signature check, no funds
(cd node && npm install && npm run pay)
python3 -m venv python/.venv && python/.venv/bin/pip install -r python/requirements.txt && python/.venv/bin/python python/pay.py
```

The local server is the real demo app with a facilitator that verifies each EIP-3009 signature against the Fuji USDC domain, rejects reused nonces and wrong destinations or amounts. Against it the clients use a throwaway key.

## Against a real endpoint

```bash
TARGET_URL=https://... NETWORK=avalancheFuji PAYER_PRIVATE_KEY=0x... npm run pay        # node/
TARGET_URL=https://... NETWORK=avalancheFuji PAYER_PRIVATE_KEY=0x... python pay.py      # python/
```

## What integrators need to know

- **Fuji USDC must be allowed explicitly.** Current x402 clients (JS 2.29, Python 2.26 at the time of writing) only pay "default assets" unless told otherwise, with a $1 cap per payment. Avalanche **mainnet** USDC is a default asset. Fuji USDC is not: add it to `spendControls.allowedAssets` (JS) or `spend_controls["allowed_assets"]` (Python), as both scripts do. The Sekisho SDK does this for you.
- The EIP-712 domain comes in the `402` (`extra.name = "USD Coin"`, `extra.version = "2"`); clients don't need to hardcode it.
