#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, readPayerKey } from "./config.js";
import { SpendLedger } from "./ledger.js";
import { VERSION, createProxy } from "./proxy.js";

// Proxy MCP por stdio: el cliente (OpenCode, Claude Code, Codex…) lo arranca como servidor local.
// Todo lo que no es protocolo MCP va a stderr.
const err = (m: string) => process.stderr.write(`${m}\n`);

try {
  const config = loadConfig();
  const account = privateKeyToAccount(readPayerKey(config.keyFile));
  const ledger = new SpendLedger(config.ledgerFile);
  const proxy = await createProxy({
    url: config.url,
    account,
    network: config.network,
    maxPerCall: config.maxPerCall,
    maxPerDay: config.maxPerDay,
    ledger,
  });
  await proxy.server.connect(new StdioServerTransport());
  err(
    `[sekisho-mcp] v${VERSION} · ${config.url.href} · ${config.network} · pagador ${account.address} · ` +
      `tope ${formatUnits(config.maxPerCall, 6)} USDC/llamada, ${formatUnits(config.maxPerDay, 6)} USDC/24 h`
  );
  const shutdown = () => void proxy.close().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  err(`[sekisho-mcp] ${(error as Error).message}`);
  process.exit(1);
}
