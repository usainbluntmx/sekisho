import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privateKeyToAccount } from "viem/accounts";
import { createSekishoMcpClient } from "../src/index.js";
import { network, requireKey } from "./env.js";

const account = privateKeyToAccount(requireKey("AGENT_PRIVATE_KEY"));

const client = createSekishoMcpClient({
  account,
  network,
  maxPerPayment: "0.05", // nunca más de 0.05 USDC por llamada
  maxPerSession: "0.50", // ni más de 0.50 USDC en toda la sesión
});

// MCP_URL=https://… → servidor MCP remoto (Streamable HTTP), p. ej. la demo API:
//   MCP_URL=https://sekisho-api.zerotwolabs.xyz/mcp MCP_TOOL=avalanche_snapshot MCP_ARGS='{}'
// Sin MCP_URL → levanta examples/mcp-server.ts como proceso hijo (stdio)
const MCP_URL = process.env.MCP_URL;
const TOOL = process.env.MCP_TOOL ?? (MCP_URL ? "avalanche_snapshot" : "premium_insight");
const ARGS = JSON.parse(process.env.MCP_ARGS ?? (MCP_URL ? "{}" : '{"topic":"Avalanche"}')) as Record<string, unknown>;

const transport = MCP_URL
  ? new StreamableHTTPClientTransport(new URL(MCP_URL))
  : new StdioClientTransport({
      command: "node",
      args: ["--env-file=.env", "--import", "tsx", "examples/mcp-server.ts"],
      stderr: "inherit",
    });

await client.connect(transport);
console.log("─────────────────────────────────────────────");
console.log("Agente MCP:", account.address, `(${network})`);
console.log("Servidor:  ", MCP_URL ?? "examples/mcp-server.ts (stdio)");

// 1) Tool gratuita
const free = await client.callTool("ping", {});
console.log("[1] ping →", JSON.stringify(free.content));

// 2) Tool de pago (402 → firma → reintento → resultado)
const result = await client.callTool(TOOL, ARGS);
console.log(`[2] ${TOOL} →`, JSON.stringify(result.content));
console.log("[2] ¿Pagó?:", result.paymentMade);
console.log("[2] Liquidación:", result.paymentResponse?.transaction);
console.log("─────────────────────────────────────────────");

process.exit(0);