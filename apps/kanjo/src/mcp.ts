/**
 * Kanjō por MCP: un agente de IA puede ver tiendas y menús, hacer un pedido y pagarlo con x402.
 * Pensado para varias tiendas: cada pedido se cobra al vault de SU tienda.
 *
 *   stores · menu · place_order · order_status  → gratis
 *   pay_order                                    → cobra el total exacto del pedido (x402)
 *
 * El cobro usa las mismas validaciones, candado y registro que el checkout web (order-payment.ts).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorClient } from "@zero-two-labs/sekisho";
import { z } from "zod";
import { formatUsdc } from "./money.js";
import { endSettlement } from "./settlement-guard.js";
import { countPendingOrders, createOrder, getOrder, getStore, listProducts, listStores, upsertCustomer } from "./store.js";
import { blockReason, claimForSettlement, quoteFor, recordSettledOrder } from "./order-payment.js";
import type { UsdcQuoteDetails } from "./payments/usdc-sekisho.js";

export const MCP_PATH = "/mcp";
/** Todos los pedidos por MCP quedan a nombre de este cliente (no hay WhatsApp al cual avisar). */
export const AGENT_CUSTOMER = "mcp-agent";

export interface McpOptions {
  facilitator: x402Facilitator;
  /** CAIP-2 de la red (eip155:43113 o eip155:43114). */
  network: `eip155:${number}`;
  /** Cotización del pedido; en pruebas se reemplaza para no tocar la RPC. */
  quote?: (orderId: string) => Promise<Pick<UsdcQuoteDetails, "vault" | "option">>;
  /** Tareas después del pago (avisos y reparto); en pruebas se reemplaza. */
  afterPaid?: (orderId: string, tx: string) => Promise<void>;
  /** Máximo de pedidos sin pagar creados por agentes, en total. */
  maxPendingOrders?: number;
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({ ...text(message), isError: true });

export async function createKanjoMcp(options: McpOptions) {
  const quote = options.quote ?? quoteFor;
  const maxPending = options.maxPendingOrders ?? 20;

  // Servidor x402 propio del canal MCP; sus hooks reutilizan el candado y el registro del checkout
  const resourceServer = new x402ResourceServer(toFacilitatorClient(options.facilitator));
  resourceServer.register(options.network, new ExactEvmScheme());
  await resourceServer.initialize();

  const current = new AsyncLocalStorage<{ orderId: string; token: string; ownsSettlement: boolean }>();

  resourceServer.onBeforeSettle(async () => {
    const ctx = current.getStore();
    if (!ctx) return;
    const refused = claimForSettlement(ctx.orderId, ctx.token);
    if (refused) return { abort: true as const, reason: refused };
    ctx.ownsSettlement = true;
  });

  resourceServer.onAfterSettle(async (context) => {
    const ctx = current.getStore();
    if (!ctx) return;
    recordSettledOrder(
      ctx.orderId,
      { tx: context.result.transaction, payer: context.result.payer, amountAtomic: Number(context.requirements.amount) },
      options.afterPaid
    );
  });

  async function payOrder(args: { order_id: string; token: string }, extra: unknown) {
    const orderId = args.order_id.trim().toUpperCase();
    const token = args.token.trim();
    const blocked = blockReason(orderId, token);
    if (blocked) return fail(blocked.error);

    // Precio dinámico: el 402 pide exactamente el total de ESTE pedido, al vault de SU tienda
    let accepts;
    try {
      const q = await quote(orderId);
      accepts = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        network: options.network,
        payTo: q.vault,
        price: q.option.price,
      });
    } catch (error) {
      console.error(`[mcp] No se pudo cotizar ${orderId}:`, error);
      return fail("El servicio de pagos no está disponible en este momento. Intenta de nuevo en unos minutos.");
    }

    const paid = createPaymentWrapper(resourceServer, {
      accepts,
      resource: { url: "mcp://tool/pay_order", description: `Pago del pedido ${orderId}`, mimeType: "application/json" },
    });
    const ctx = { orderId, token, ownsSettlement: false };
    try {
      return await current.run(ctx, () =>
        paid(async () => {
          const found = getOrder(orderId)!;
          return text({
            order_id: orderId,
            status: "paid",
            total_usdc: formatUsdc(found.order.total_atomic),
            message: "Pago recibido. La tienda ya fue avisada.",
          });
        })(args as Record<string, unknown>, extra as never)
      );
    } finally {
      if (ctx.ownsSettlement) endSettlement(orderId);
    }
  }

  /** Un servidor MCP por petición (modo sin sesión: nunca se cruzan clientes). */
  function build(): McpServer {
    const server = new McpServer({ name: "kanjo", version: "0.1.0" });

    server.tool("stores", "Free. Lists the stores you can buy from (id and name).", {}, async () =>
      text(listStores().map((s) => ({ id: s.id, name: s.name })))
    );

    server.tool(
      "menu",
      "Free. Products of a store with their id, price in USDC and whether they are available.",
      { store_id: z.string().min(1).max(64) },
      async ({ store_id }) => {
        const store = getStore(store_id);
        if (!store) return fail(`No existe la tienda "${store_id}". Usa la tool stores.`);
        return text({
          store: { id: store.id, name: store.name },
          currency: "USDC",
          products: listProducts(store.id).map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description || undefined,
            category: p.category || undefined,
            price_usdc: formatUsdc(p.price_atomic),
            available: p.stock,
          })),
        });
      }
    );

    server.tool(
      "place_order",
      "Free. Creates an order (not paid yet) and returns order_id, token and total. Then call pay_order to pay it.",
      {
        store_id: z.string().min(1).max(64),
        items: z
          .array(z.object({ product_id: z.number().int().positive(), quantity: z.number().int().positive().max(100) }))
          .min(1)
          .max(30),
      },
      async ({ store_id, items }) => {
        const store = getStore(store_id);
        if (!store) return fail(`No existe la tienda "${store_id}". Usa la tool stores.`);
        if (countPendingOrders("mcp-") >= maxPending) {
          return fail("Hay demasiados pedidos de agentes sin pagar. Paga uno pendiente o intenta más tarde.");
        }
        upsertCustomer(AGENT_CUSTOMER, "Agente de IA");
        try {
          const { order, items: lines } = createOrder(
            store.id,
            AGENT_CUSTOMER,
            items.map((i) => ({ productId: i.product_id, quantity: i.quantity }))
          );
          return text({
            order_id: order.id,
            token: order.pay_token,
            store: store.name,
            items: lines.map((l) => ({ name: l.name, quantity: l.quantity, unit_price_usdc: formatUsdc(l.unit_price_atomic) })),
            total_usdc: formatUsdc(order.total_atomic),
            next: "Call pay_order with order_id and token. It charges exactly total_usdc in USDC (x402).",
          });
        } catch (error) {
          return fail((error as Error).message);
        }
      }
    );

    server.tool(
      "order_status",
      "Free. Status of an order (pending_payment, paid or cancelled).",
      { order_id: z.string().min(1).max(32), token: z.string().min(1).max(64) },
      async ({ order_id, token }) => {
        const orderId = order_id.trim().toUpperCase();
        const blocked = blockReason(orderId, token.trim());
        const found = getOrder(orderId);
        if (!found || blocked?.status === 404) return fail("Pedido no encontrado.");
        return text({
          order_id: orderId,
          status: found.order.status,
          total_usdc: formatUsdc(found.order.total_atomic),
          payment_tx: found.order.payment_tx ?? undefined,
        });
      }
    );

    server.tool(
      "pay_order",
      "Paid. Charges the exact order total in USDC with x402 and marks the order as paid. Needs order_id and token from place_order.",
      { order_id: z.string().min(1).max(32), token: z.string().min(1).max(64) },
      (args, extra) => payOrder(args, extra)
    );

    return server;
  }

  /** Responde una petición HTTP de MCP (Streamable HTTP, sin sesión). */
  async function handle(request: Request): Promise<Response> {
    const server = build();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      void server.close();
    }
  }

  return { handle };
}

/** Monta /mcp en la app (con límite por IP; el límite de body ya es global). */
export async function registerMcp(app: Hono, options: McpOptions, limit: Parameters<Hono["use"]>[1]): Promise<void> {
  const mcp = await createKanjoMcp(options);
  app.use(MCP_PATH, limit);
  app.all(MCP_PATH, (c) => mcp.handle(c.req.raw));
}
