import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { privateKeyToAccount } from "viem/accounts";
import {
  createSekishoClient,
  createPaymentOption,
  createSekishoFacilitator,
} from "../src/index.js";

// Vendedor de prueba (el mismo del Paso 5)
const MERCHANT = (process.env.MERCHANT_ADDRESS ??
  "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae") as `0x${string}`;
const PORT = 4021;

const facilitatorKey = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined;
if (!facilitatorKey) throw new Error("Falta FACILITATOR_PRIVATE_KEY en sdk/.env");
const facilitatorAccount = privateKeyToAccount(facilitatorKey);

// 1) Sekisho arma la opción de pago con payTo = vault del vendedor
const sekisho = createSekishoClient({ network: "avalancheFuji" });
const option = await createPaymentOption(sekisho, {
  merchant: MERCHANT,
  price: "0.01",
});

// 2) Facilitator local (verifica y liquida en Avalanche directamente)
const facilitator = createSekishoFacilitator({
  account: facilitatorAccount,
  network: "avalancheFuji",
});

const resourceServer = new x402ResourceServer({
  verify: facilitator.verify.bind(facilitator),
  settle: facilitator.settle.bind(facilitator),
  getSupported: async () => facilitator.getSupported(),
}).register(option.network, new ExactEvmScheme());

// 3) App Hono con un endpoint gratuito y uno de pago
const app = new Hono();

app.use(
  paymentMiddleware(
    {
      "GET /premium": {
        accepts: [option],
        description: "Contenido premium de ejemplo (Sekisho demo)",
        mimeType: "application/json",
      },
    },
    resourceServer
  )
);

app.get("/", (c) =>
  c.json({ service: "Sekisho demo", paidEndpoint: "/premium", payTo: option.payTo })
);

app.get("/premium", (c) =>
  c.json({
    message: "Pagaste con x402 en Avalanche. Bienvenido a Sekisho.",
    paidTo: option.payTo,
  })
);

serve({ fetch: app.fetch, port: PORT });

console.log("─────────────────────────────────────────────");
console.log(`Servidor:      http://localhost:${PORT}`);
console.log(`Endpoint $:    GET /premium (0.01 USDC)`);
console.log(`Red:           ${option.network}`);
console.log(`payTo (vault): ${option.payTo}`);
console.log(`Facilitator:   local (${facilitatorAccount.address})`);
console.log("─────────────────────────────────────────────");