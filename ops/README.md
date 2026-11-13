# Sekisho ops

Health check for the live deployment, with alerts to Telegram. It reads only public data: operator AVAX balances, pending USDC in the watched vaults, `/v1/metrics`, endpoint health, admin events on the factory and the Safe, and the last CI run. No private keys are involved.

```bash
npm install
npm run check                 # report in the terminal, sends nothing
npm run check -- --notify     # Telegram: only what changed (new, still open every 6 h, resolved)
npm run check -- --summary    # Telegram: the full report
```

What it watches is in [`watch.json`](watch.json) (public addresses, minimum balances, split thresholds).

| Alert | Condition |
| --- | --- |
| Low AVAX | An operator is below its `minAvax`: without gas, payments are not settled |
| Endpoint down | Non-2xx or no answer in 10 s. An endpoint with `expect` must return that exact status and content type instead: Kanjō's payment page is requested with a fake order and must answer `404` in HTML (the store's "order not found" page); a plain-text `404` means the route is gone |
| Overdue split | Pending ≥ the merchant's `splitAtUsdc`, or ≥ 0.25 USDC with the last payment more than 26 h ago |
| Metrics stalled | The indexer is more than 900 blocks behind the chain |
| Admin event | Fee, treasury or ownership change on the factory; any executed transaction or owner change on the Safe |
| Service broken | A service in [`services.json`](../apps/web/public/services.json) no longer answers a `402` with the listed price, network, USDC and vault (checked without paying) |
| CI failed | The last `CI` run on `main` did not succeed |

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and keep its token private.
2. Send any message to your bot, then get your chat id: `npm run telegram:chat-id` (with `TELEGRAM_BOT_TOKEN` in the environment).
3. Locally, put both values in `ops/.env` (git-ignored). On GitHub, add them as repository secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

The [`Monitor`](../.github/workflows/monitor.yml) workflow is scheduled every 30 minutes (`--notify`, at minutes 13 and 43) and sends a daily summary at 08:07 Mexico City time (`--summary`). It runs on GitHub, outside our own server, so it still alerts if the server goes down. Alert state is kept between runs in the Actions cache. GitHub does not guarantee scheduled runs: they can start late or be skipped when Actions is busy (the start of every hour is the worst time, which is why it runs at :13 and :43). In practice the gap between checks is usually 30 minutes but can be hours, so treat it as a safety net, not real-time monitoring. If an alert's data source fails during a run (the RPC, `/v1/metrics`, GitHub), alerts that depend on it stay open instead of being reported as resolved.
