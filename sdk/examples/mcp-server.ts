import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import {
  createSekishoClient,
  createSekishoDistributor,
  createSekishoFacilitator,
  createSekishoMcpPaywall,
} from "../src/index.js";
import { MERCHANT, network, policyFromEnv, requireKey } from "./env.js";

const account = privateKeyToAccount(requireKey("FACILITATOR_PRIVATE_KEY"));

const sekisho = createSekishoClient({ network, account });
const facilitator = createSekishoFacilitator({ account, network });

// Reparto automático por política (en stdio, la bitácora va a stderr)
const distributor = createSekishoDistributor({
  sekisho,
  merchants: [MERCHANT],
  policy: policyFromEnv(),
  log: (message) => console.error(message),
});

// Paywall: 0.01 USDC por llamada; cada pago avisa al repartidor
const paid = await createSekishoMcpPaywall({
  sekisho,
  facilitator,
  merchant: MERCHANT,
  price: "0.01",
  distributor,
  onSettled: ({ toolName, transaction }) => {
    console.error(`[sekisho] ${toolName} pagado → ${sekisho.config.explorer}/tx/${transaction}`);
  },
});

const server = new McpServer({ name: "sekisho-demo", version: "0.1.0" });

// Tool gratuita
server.tool("ping", "Health check gratuito", {}, async () => ({
  content: [{ type: "text", text: "pong" }],
}));

// Tool de pago
server.tool(
  "premium_insight",
  "Insight premium sobre un tema. Cuesta 0.01 USDC (x402 en Avalanche).",
  { topic: z.string() },
  paid(async (args: { topic: string }) => ({
    content: [
      {
        type: "text",
        text: `Insight premium sobre "${args.topic}": pagado con x402 en Avalanche vía Sekisho.`,
      },
    ],
  }))
);

await server.connect(new StdioServerTransport());
distributor.start();
console.error(`[sekisho] MCP server listo (stdio, ${network})`);