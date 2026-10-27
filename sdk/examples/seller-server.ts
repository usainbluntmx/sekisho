import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { privateKeyToAccount } from "viem/accounts";
import {
  createSekishoClient,
  createPaymentOption,
  createSekishoDistributor,
  createSekishoFacilitator,
  toFacilitatorClient,
} from "../src/index.js";
import { MERCHANT, network, policyFromEnv, requireKey } from "./env.js";

const PORT = Number(process.env.PORT ?? 4021);
const PRICE = process.env.PRICE_USDC ?? "0.01";

// Llave del servidor: liquida los pagos y reparte (necesita AVAX para gas, ningún permiso en los contratos)
const operator = privateKeyToAccount(requireKey("FACILITATOR_PRIVATE_KEY"));

// 1) Sekisho arma la opción de pago con payTo = vault del vendedor
const sekisho = createSekishoClient({ network, account: operator });
const option = await createPaymentOption(sekisho, { merchant: MERCHANT, price: PRICE });

// 2) Facilitator local (verifica y liquida en Avalanche directamente)
const facilitator = createSekishoFacilitator({ account: operator, network });

const resourceServer = new x402ResourceServer(toFacilitatorClient(facilitator)).register(
  option.network,
  new ExactEvmScheme()
);

// 3) Reparto automático: revisa después de cada pago y cada 15 min.
//    Reparte al llegar a DISTRIBUTE_MIN_USDC (5 por defecto) o a las 24 h con ≥ 0.25 USDC.
const distributor = createSekishoDistributor({
  sekisho,
  merchants: [MERCHANT],
  policy: policyFromEnv(),
});

resourceServer.onAfterSettle(async (context) => {
  console.log(`[pago] ${context.result.transaction} liquidado → ${option.payTo}`);
  distributor.notePayment(MERCHANT);
  void distributor.check(); // sin await: la respuesta al cliente no espera al reparto
});

// 4) App Hono con un endpoint gratuito y uno de pago
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
  c.json({ service: "Sekisho demo", network: option.network, paidEndpoint: "/premium", payTo: option.payTo })
);

app.get("/premium", (c) =>
  c.json({
    message: "Pagaste con x402 en Avalanche. Bienvenido a Sekisho.",
    paidTo: option.payTo,
  })
);

serve({ fetch: app.fetch, port: PORT });
distributor.start();

console.log("─────────────────────────────────────────────");
console.log(`Servidor:      http://localhost:${PORT}`);
console.log(`Endpoint $:    GET /premium (${PRICE} USDC)`);
console.log(`Red:           ${network} (${option.network})`);
console.log(`payTo (vault): ${option.payTo}`);
console.log(`Operador:      ${operator.address} (liquida y reparte)`);
console.log("─────────────────────────────────────────────");
