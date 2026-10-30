import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { formatEther, getAddress, nonceManager, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPaymentOption,
  createSekishoClient,
  createSekishoDistributor,
  createSekishoFacilitator,
  toFacilitatorClient,
  type SekishoNetwork,
} from "@zero-two-labs/sekisho";

// ── Configuración (.env) ──────────────────────────────────────────
const network = (process.env.NETWORK || "avalancheFuji") as SekishoNetwork;
const merchant = getAddress(process.env.MERCHANT_ADDRESS ?? "");
const price = process.env.PRICE_USDC || "0.01";
const port = Number(process.env.PORT ?? 3000);
const operator = privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as Hex, { nonceManager });

// ── Sekisho: cobro x402 → SplitVault del vendedor → reparto automático ──
const sekisho = createSekishoClient({ network, account: operator });
const facilitator = createSekishoFacilitator({ account: operator, network });
const option = await createPaymentOption(sekisho, { merchant, price });

const resourceServer = new x402ResourceServer(toFacilitatorClient(facilitator)).register(option.network, new ExactEvmScheme());

// Reparte por lotes: al juntar DISTRIBUTE_MIN_USDC (5 por defecto) o a las 24 h con ≥ 0.25 USDC
const distributor = createSekishoDistributor({
  sekisho,
  merchants: [merchant],
  policy: process.env.DISTRIBUTE_MIN_USDC ? { minUsdc: process.env.DISTRIBUTE_MIN_USDC } : {},
});
resourceServer.onAfterSettle(async ({ result }) => {
  console.log(`💸 Pago recibido → ${sekisho.config.explorer}/tx/${result.transaction}`);
  distributor.notePayment(merchant);
  void distributor.check();
});

// ── Tu API ────────────────────────────────────────────────────────
const app = new Hono();

app.get("/", (c) =>
  c.json({
    service: "Mi API de pago",
    paid: { "GET /premium": `${price} USDC (x402 en Avalanche)` },
    payTo: option.payTo,
    network: option.network,
  })
);

// Rutas de pago: agrega más entradas con el mismo `accepts` (o crea otra opción con otro precio)
app.use(
  paymentMiddleware(
    { "GET /premium": { accepts: [option], description: "Contenido de pago", mimeType: "application/json" } },
    resourceServer
  )
);

// 👇 Reemplaza esto con lo que vendes
app.get("/premium", (c) => c.json({ message: "Pagaste con x402. Aquí va tu contenido de pago.", at: new Date().toISOString() }));

serve({ fetch: app.fetch, port });
distributor.start();

// ── Arranque ──────────────────────────────────────────────────────
const balance = await sekisho.publicClient.getBalance({ address: operator.address }).catch(() => null);
console.log(`
  Sekisho · ${network === "avalanche" ? "MAINNET (USDC real)" : "Fuji testnet"}
  Servidor:  http://localhost:${port}
  De pago:   GET /premium · ${price} USDC
  Vendedor:  ${merchant} → vault ${option.payTo}
  Operador:  ${operator.address} · ${balance === null ? "?" : formatEther(balance)} AVAX
`);
if (balance === 0n) {
  console.warn(`  ⚠️  El operador no tiene AVAX: mándale un poco a ${operator.address} para el gas de cada cobro.\n`);
}
