import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

// El agente levanta el servidor MCP como proceso hijo (stdio)
const transport = new StdioClientTransport({
  command: "node",
  args: ["--env-file=.env", "--import", "tsx", "examples/mcp-server.ts"],
  stderr: "inherit",
});

await client.connect(transport);
console.log("─────────────────────────────────────────────");
console.log("Agente MCP:", account.address, `(${network})`);

// 1) Tool gratuita
const free = await client.callTool("ping", {});
console.log("[1] ping →", JSON.stringify(free.content));

// 2) Tool de pago (402 → firma → reintento → resultado)
const result = await client.callTool("premium_insight", { topic: "Avalanche" });
console.log("[2] premium_insight →", JSON.stringify(result.content));
console.log("[2] ¿Pagó?:", result.paymentMade);
console.log("[2] Liquidación:", result.paymentResponse?.transaction);
console.log("─────────────────────────────────────────────");

process.exit(0);