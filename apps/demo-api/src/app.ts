import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { formatGwei, formatUnits, type Address } from "viem";
import type { x402Facilitator } from "@x402/core/facilitator";
import {
  SDK_VERSION,
  createPaymentOption,
  createSekishoDistributor,
  createSekishoMcpPaywall,
  toFacilitatorClient,
  type DistributionPolicy,
  type SekishoClient,
  type SekishoDistributor,
  type SekishoNetwork,
  type SekishoPaymentOption,
} from "@zero-two-labs/sekisho";
import type { MetricsIndexer } from "./metrics.js";

export interface DemoAppOptions {
  /** Cliente de Sekisho con `account` (liquida y reparte). */
  sekisho: SekishoClient;
  facilitator: x402Facilitator;
  network: SekishoNetwork;
  merchant: Address;
  priceUsdc: string;
  ratePerMinute: number;
  distributionPolicy?: Partial<DistributionPolicy>;
  checkMinutes?: number;
  /** Datos del endpoint de pago; por defecto, el snapshot de la cadena. Los tests lo reemplazan. */
  snapshot?: () => Promise<Record<string, unknown>>;
  log?: (message: string) => void;
  /** Métricas on-chain para GET /v1/metrics (público y gratis). */
  metrics?: Pick<MetricsIndexer, "snapshot">;
}

export interface DemoApp {
  app: Hono;
  option: SekishoPaymentOption;
  distributor: SekishoDistributor;
}

/** Arma la app sin abrir puertos ni arrancar temporizadores (index.ts lo hace). */
export async function createDemoApp(options: DemoAppOptions): Promise<DemoApp> {
const { sekisho, facilitator } = options;
const config = { ...options, checkMinutes: options.checkMinutes ?? 15 };
const log = options.log ?? ((message: string) => console.log(message));
const option = await createPaymentOption(sekisho, { merchant: config.merchant, price: config.priceUsdc });

const PAID_ROUTE = "/v1/avalanche/snapshot";
const MCP_ROUTE = "/mcp";
const MCP_TOOL = "avalanche_snapshot";
const DOCS = "https://github.com/usainbluntmx/sekisho/tree/main/apps/demo-api";

const resourceServer = new x402ResourceServer(toFacilitatorClient(facilitator)).register(
  option.network,
  new ExactEvmScheme()
);

// ───── Reparto automático ─────
const distributor = createSekishoDistributor({
  sekisho,
  merchants: [config.merchant],
  policy: config.distributionPolicy,
  intervalMinutes: config.checkMinutes,
  log: (message) => log(message.replace("[sekisho]", "[distributor]")),
});

resourceServer.onAfterSettle(async (context) => {
  const amount = formatUnits(BigInt(context.requirements.amount), 6);
  log(
    `[pago] ${amount} USDC de ${context.result.payer} → ${sekisho.config.explorer}/tx/${context.result.transaction}`
  );
  distributor.notePayment(config.merchant);
  void distributor.check(); // la respuesta no espera al reparto
});
resourceServer.onSettleFailure(async (context) => {
  console.error(`[pago] Falló la liquidación: ${context.error.message}`);
});

// ───── MCP: la misma consulta como tool de pago (Streamable HTTP, sin sesión) ─────
const paidTool = await createSekishoMcpPaywall({
  sekisho,
  facilitator,
  merchant: config.merchant,
  price: config.priceUsdc,
  distributor,
  // x402 MCP no conoce el nombre registrado de la tool (reporta "paid_tool"): se usa el nuestro
  onSettled: ({ transaction }) =>
    log(`[pago] MCP ${MCP_TOOL} → ${sekisho.config.explorer}/tx/${transaction}`),
});

/** Un servidor MCP por petición: en modo sin sesión, así nunca se cruzan ids entre clientes. */
function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "sekisho-demo-api", version: SDK_VERSION });
  server.tool("ping", "Free health check", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
  server.tool(
    MCP_TOOL,
    `Latest Avalanche block, gas price and Sekisho config. Costs ${config.priceUsdc} USDC (x402 on Avalanche).`,
    {},
    paidTool(async () => ({
      content: [{ type: "text", text: JSON.stringify({ ...(await avalancheSnapshot()), paidTo: option.payTo }) }],
    }))
  );
  return server;
}

// ───── Límite por IP (en memoria; el servicio corre en una instancia) ─────
function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

function rateLimit(maxPerMinute: number): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, 60_000).unref();

  return async (c, next) => {
    const now = Date.now();
    const key = clientIp(c);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + 60_000 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > maxPerMinute) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: "Too many requests. Try again in a minute." }, 429);
    }
    await next();
  };
}

// ───── Datos del endpoint de pago (con caché corta para no saturar la RPC) ─────
let snapshotCache: { at: number; data: Record<string, unknown> } | undefined;

async function chainSnapshot(): Promise<Record<string, unknown>> {
  if (snapshotCache && Date.now() - snapshotCache.at < 5_000) return snapshotCache.data;
  const [block, gasPrice, sekishoConfig] = await Promise.all([
    sekisho.publicClient.getBlock(),
    sekisho.publicClient.getGasPrice(),
    sekisho.getConfig(),
  ]);
  const data = {
    chainId: sekisho.config.chain.id,
    block: {
      number: block.number.toString(),
      timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
      transactions: block.transactions.length,
      gasUsed: block.gasUsed.toString(),
      baseFeeNAvax: block.baseFeePerGas === null || block.baseFeePerGas === undefined ? null : formatGwei(block.baseFeePerGas),
    },
    gasPriceNAvax: formatGwei(gasPrice),
    sekisho: {
      factory: sekishoConfig.factory,
      treasury: sekishoConfig.treasury,
      feeBps: sekishoConfig.feeBps,
      feeChange: sekishoConfig.feeChange
        ? { feeBps: sekishoConfig.feeChange.feeBps, effectiveAt: sekishoConfig.feeChange.effectiveAt.toISOString() }
        : null,
    },
  };
  snapshotCache = { at: Date.now(), data };
  return data;
}

const avalancheSnapshot = options.snapshot ?? chainSnapshot;

// ───── App ─────
const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.use("*", rateLimit(config.ratePerMinute));

// MCP antes del paywall HTTP: el cobro de la tool lo hace el wrapper de x402 MCP, no el middleware HTTP.
// 64 KB bastan para cualquier llamada MCP y cortan bodies enormes antes de validarlos.
app.all(MCP_ROUTE, bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    void server.close();
  }
});

app.get("/", (c) =>
  c.json({
    service: "Sekisho demo API",
    description: "Pay per call in USDC with x402 on Avalanche. Every payment lands in the seller's SplitVault.",
    network: config.network,
    caip2: option.network,
    sdk: SDK_VERSION,
    endpoints: {
      free: {
        "GET /": "this document",
        "GET /health": "liveness",
        ...(options.metrics ? { "GET /v1/metrics": "on-chain Sekisho metrics: payments, volume, vaults, splits" } : {}),
      },
      paid: { [`GET ${PAID_ROUTE}`]: `${config.priceUsdc} USDC — latest Avalanche block, gas price and Sekisho config` },
      mcp: {
        url: MCP_ROUTE,
        transport: "Streamable HTTP (stateless)",
        tools: { ping: "free", [MCP_TOOL]: `${config.priceUsdc} USDC per call` },
      },
    },
    payment: {
      scheme: "exact",
      asset: sekisho.config.usdc,
      price: config.priceUsdc,
      payTo: option.payTo,
      merchant: config.merchant,
      factory: sekisho.config.factory,
    },
    howToPay: {
      install: "npm install @zero-two-labs/sekisho viem",
      code: [
        'import { createSekishoFetch } from "@zero-two-labs/sekisho";',
        `const { fetch: pay } = createSekishoFetch({ account, network: "${config.network}", maxPerPayment: "${config.priceUsdc}" });`,
        `const res = await pay("<this host>${PAID_ROUTE}");`,
      ],
    },
    docs: DOCS,
  })
);

// Métricas públicas: la web las lee desde el navegador (CORS abierto, solo GET, caché de 30 s)
const metrics = options.metrics;
if (metrics) {
  app.get("/v1/metrics", cors({ origin: "*", allowMethods: ["GET"] }), (c) => {
    c.header("Cache-Control", "public, max-age=30");
    return c.json(metrics.snapshot());
  });
}

app.use(
  paymentMiddleware(
    {
      [`GET ${PAID_ROUTE}`]: {
        accepts: [option],
        description: "Latest Avalanche block, gas price and Sekisho config",
        mimeType: "application/json",
      },
    },
    resourceServer
  )
);

app.get(PAID_ROUTE, async (c) => c.json({ ...(await avalancheSnapshot()), paidTo: option.payTo }));


return { app, option, distributor };
}
