# @zero-two-labs/sekisho-mcp

A local MCP server that lets **OpenCode, Claude Code, Codex or any MCP client** use paid MCP tools. It connects to a remote MCP server that charges per call with [x402](https://x402.org) (USDC on Avalanche), shows its tools to your agent, and pays the paid ones from your wallet, never above your caps.

- **Per-call cap** (`SEKISHO_MAX_PER_CALL`, default 0.05 USDC): a tool that costs more is refused, nothing is signed.
- **24-hour cap** (`SEKISHO_MAX_PER_DAY`, default 1 USDC): kept in a file on disk, so it holds across restarts and sessions.
- **The key never goes in your editor config.** It is read from a private file (`chmod 600`); the proxy refuses a file other users can read.
- Extra free tool `sekisho_wallet`: payer address, network, caps and what was spent in the last 24 h.

Works with any x402 `exact` MCP server on Avalanche, not only Sekisho sellers.

## 1. The payer key

Use a wallet only for this, with a small amount of USDC. It does not need AVAX: the seller pays the gas.

```bash
mkdir -p ~/.config/sekisho && chmod 700 ~/.config/sekisho
read -s KEY && printf '%s\n' "$KEY" > ~/.config/sekisho/payer.key && chmod 600 ~/.config/sekisho/payer.key && unset KEY
```

## 2. OpenCode

In `opencode.json` (project root) or `~/.config/opencode/opencode.json` (global), per the [OpenCode MCP docs](https://opencode.ai/docs/mcp-servers):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sekisho": {
      "type": "local",
      "command": ["npx", "-y", "@zero-two-labs/sekisho-mcp"],
      "enabled": true,
      "environment": {
        "SEKISHO_MCP_URL": "https://sekisho-api.zerotwolabs.xyz/mcp",
        "SEKISHO_NETWORK": "avalanche",
        "SEKISHO_MAX_PER_CALL": "0.01",
        "SEKISHO_MAX_PER_DAY": "0.50"
      },
      "timeout": 60000
    }
  }
}
```

Other clients: register a local (stdio) MCP server that runs `npx -y @zero-two-labs/sekisho-mcp` with the same environment variables.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEKISHO_MCP_URL` | (required) | Remote paid MCP server (Streamable HTTP). `https`, or `http` on localhost only |
| `SEKISHO_NETWORK` | `avalancheFuji` | `avalancheFuji` (testnet) or `avalanche` (mainnet, real USDC) |
| `SEKISHO_MAX_PER_CALL` | `0.05` | Max USDC per tool call |
| `SEKISHO_MAX_PER_DAY` | `1` | Max USDC in any 24 h window |
| `SEKISHO_PAYER_KEY_FILE` | `~/.config/sekisho/payer.key` | Private key file (`0x` + 64 hex, mode 600) |
| `SEKISHO_LEDGER_FILE` | `~/.config/sekisho/spend.json` | Spend log used for the 24 h cap |

A signed payment counts toward the cap even if the server then fails to settle it. Logs go to stderr; stdout is the MCP protocol.

MIT · [Sekisho](https://sekisho.zerotwolabs.xyz) by Zero Two Labs
