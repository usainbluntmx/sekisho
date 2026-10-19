import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import {
  createSekishoClient,
  createSekishoFacilitator,
  createSekishoMcpPaywall,
} from "../src/index.js";

const MERCHANT = (process.env.MERCHANT_ADDRESS ??
  "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae") as `0x${string}`;

const key = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error("Falta FACILITATOR_PRIVATE_KEY en sdk/.env");
const account = privateKeyToAccount(key);

const sekisho = createSekishoClient({ network: "avalancheFuji", account });
const facilitator = createSekishoFacilitator({ account, network: "avalancheFuji" });

// Paywall: 0.01 USDC por llamada, con reparto automático después de cada pago
const paid = await createSekishoMcpPaywall({
  sekisho,
  facilitator,
  merchant: MERCHANT,
  price: "0.01",
  onSettled: async ({ toolName, transaction }) => {
    console.error(`[sekisho] ${toolName} pagado → ${sekisho.config.explorer}/tx/${transaction}`);
    const hash = await sekisho.distribute(MERCHANT);
    console.error(`[sekisho] reparto     → ${sekisho.config.explorer}/tx/${hash}`);
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
console.error("[sekisho] MCP server listo (stdio)");