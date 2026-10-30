import { config } from "./config.js";
import { serve } from "@hono/node-server";
import { nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSekishoClient, createSekishoFacilitator } from "@zero-two-labs/sekisho";
import { createDemoApp } from "./app.js";

// Operador: liquida y reparte con la misma llave. El nonceManager evita choques de nonce
// cuando un settlement y un reparto salen al mismo tiempo.
const operator = privateKeyToAccount(config.operatorKey, { nonceManager });
const sekisho = createSekishoClient({ network: config.network, account: operator, rpcUrl: config.rpcUrl });
const facilitator = createSekishoFacilitator({ account: operator, network: config.network, rpcUrl: config.rpcUrl });

const { app, option, distributor } = await createDemoApp({
  sekisho,
  facilitator,
  network: config.network,
  merchant: config.merchant,
  priceUsdc: config.priceUsdc,
  ratePerMinute: config.ratePerMinute,
  distributionPolicy: config.distributionPolicy,
  checkMinutes: config.checkMinutes,
});

serve({ fetch: app.fetch, port: config.port });
distributor.start();

console.log("─────────────────────────────────────────────");
console.log(`[demo-api] Red:       ${config.network} (${option.network})${config.network === "avalanche" ? " · MAINNET, USDC real" : ""}`);
console.log(`[demo-api] Factory:   ${sekisho.config.factory}`);
console.log(`[demo-api] Vendedor:  ${config.merchant} → vault ${option.payTo}`);
console.log(`[demo-api] Operador:  ${operator.address} (liquida y reparte; solo necesita AVAX)`);
console.log(`[demo-api] Precio:    ${config.priceUsdc} USDC · GET /v1/avalanche/snapshot · MCP /mcp (avalanche_snapshot)`);
console.log(`[demo-api] Puerto:    ${config.port}`);
console.log("─────────────────────────────────────────────");
