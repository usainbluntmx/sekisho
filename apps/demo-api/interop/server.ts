import { serve } from "@hono/node-server";
import { formatUnits } from "viem";
import { createDemoApp } from "../src/app.js";
import { fakeSekisho, MERCHANT, strictFacilitator } from "./fixtures.js";

// Demo API local para probar clientes x402 de terceros, sin cadena y sin fondos:
//   npm run interop:server            → http://localhost:4402
// La firma de cada pago se verifica de verdad (EIP-3009 / EIP-712 del USDC de Fuji).
const port = Number(process.env.INTEROP_PORT || 4402);

const { facilitator } = strictFacilitator((p) =>
  console.log(`[interop] pago verificado: ${formatUnits(p.value, 6)} USDC de ${p.payer} → ${p.to}`)
);
const { app } = await createDemoApp({
  sekisho: fakeSekisho(),
  facilitator,
  network: "avalancheFuji",
  merchant: MERCHANT,
  priceUsdc: "0.01",
  ratePerMinute: 1000,
  snapshot: async () => ({ chainId: 43113, interop: true }),
  log: (m) => console.log(m),
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () =>
  console.log(`[interop] listo en http://127.0.0.1:${port} (GET /v1/avalanche/snapshot · 0.01 USDC)`)
);
