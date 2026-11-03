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
| Endpoint down | Non-2xx or no answer in 10 s |
| Overdue split | Pending ≥ the merchant's `splitAtUsdc`, or ≥ 0.25 USDC with the last payment more than 26 h ago |
| Metrics stalled | The indexer is more than 900 blocks behind the chain |
| Admin event | Fee, treasury or ownership change on the factory; any executed transaction or owner change on the Safe |
| CI failed | The last `CI` run on `main` did not succeed |

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and keep its token private.
2. Send any message to your bot, then get your chat id: `npm run telegram:chat-id` (with `TELEGRAM_BOT_TOKEN` in the environment).
3. Locally, put both values in `ops/.env` (git-ignored). On GitHub, add them as repository secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

The [`Monitor`](../.github/workflows/monitor.yml) workflow runs every 30 minutes (`--notify`) and sends a daily summary at 08:07 Mexico City time (`--summary`). It runs on GitHub, outside our own server, so it still alerts if the server goes down. Alert state is kept between runs in the Actions cache.
