import { AsyncLocalStorage } from "node:async_hooks";
import type { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { toFacilitatorClient } from "@zero-two-labs/sekisho";
import { getOrder, getStore, markOrderPaid } from "./store.js";
import { getPaymentMethod } from "./payments/index.js";
import { facilitator, sekisho, type UsdcQuoteDetails } from "./payments/usdc-sekisho.js";
import { renderCheckoutPage, renderNotFound } from "./web/checkout-page.js";
import { notifyOrderPaid } from "./notify.js";

const STORE_ID = process.env.STORE_ID ?? "cafe-kanjo";
const NETWORK = `eip155:${sekisho.config.chain.id}` as const;

/** Lleva el id del pedido a lo largo de la petición de pago (hasta el hook de liquidación). */
const paymentContext = new AsyncLocalStorage<{ orderId: string }>();

type QueryParamReader = { adapter: { getQueryParam?: (name: string) => string | string[] | undefined } };

function orderIdFrom(context: QueryParamReader): string {
  const value = context.adapter.getQueryParam?.("order");
  return (Array.isArray(value) ? value[0] : value ?? "").toUpperCase();
}

async function quoteFor(orderId: string): Promise<UsdcQuoteDetails> {
  const found = getOrder(orderId);
  const store = getStore(STORE_ID);
  if (!found || !store) throw new Error(`Pedido no encontrado: ${orderId}`);
  const quote = await getPaymentMethod().createQuote(found.order, store);
  return quote.details as UsdcQuoteDetails;
}

/** Tareas posteriores al pago: repartir en el vault y avisar a cliente y tienda. */
async function afterOrderPaid(orderId: string, tx: string): Promise<void> {
  const found = getOrder(orderId);
  const store = getStore(STORE_ID);
  if (!found || !store) return;

  try {
    await getPaymentMethod().afterPaid?.(found.order, store, tx);
  } catch (error) {
    console.error("[checkout] El reparto falló (se puede reintentar con distribute):", error);
  }

  try {
    await notifyOrderPaid(orderId, tx, sekisho.config.explorer);
  } catch (error) {
    console.error("[checkout] Los avisos fallaron:", error);
  }
}

export function registerCheckout(app: Hono): void {
  const resourceServer = new x402ResourceServer(toFacilitatorClient(facilitator)).register(
    NETWORK,
    new ExactEvmScheme()
  );

  // Después de liquidar: marcar pagado y lanzar tareas en segundo plano
  resourceServer.onAfterSettle(async (context) => {
    const orderId = paymentContext.getStore()?.orderId;
    if (!orderId) return;

    const tx = context.result.transaction;
    if (!markOrderPaid(orderId, tx)) return;
    console.log(`[checkout] Pedido ${orderId} pagado → ${sekisho.config.explorer}/tx/${tx}`);

    void afterOrderPaid(orderId, tx);
  });

  // 1) Página de pago
  app.get("/pay/:orderId", (c) => {
    const orderId = c.req.param("orderId").toUpperCase();
    const found = getOrder(orderId);
    const store = getStore(STORE_ID);
    if (!found || !store) return c.html(renderNotFound(), 404);

    return c.html(
      renderCheckoutPage({
        store,
        order: found.order,
        items: found.items,
        usdc: sekisho.config.usdc,
        explorer: sekisho.config.explorer,
      })
    );
  });

  // 2) Validación del pedido antes de cobrar
  app.use("/api/pay", async (c, next) => {
    const orderId = (c.req.query("order") ?? "").toUpperCase();
    const found = getOrder(orderId);
    if (!found) return c.json({ error: "Pedido no encontrado" }, 404);
    if (found.order.status !== "pending_payment") {
      return c.json({ error: "El pedido ya no está pendiente de pago", status: found.order.status }, 409);
    }
    await paymentContext.run({ orderId }, () => next());
  });

  // 3) Cobro x402 con precio y destinatario dinámicos por pedido
  app.use(
    paymentMiddleware(
      {
        "GET /api/pay": {
          accepts: [
            {
              scheme: "exact",
              network: NETWORK,
              price: async (context) => (await quoteFor(orderIdFrom(context))).option.price,
              payTo: async (context) => (await quoteFor(orderIdFrom(context))).vault,
            },
          ],
          description: "Pago de pedido Kanjō",
          mimeType: "application/json",
        },
      },
      resourceServer
    )
  );

  // 4) Respuesta una vez pagado
  app.get("/api/pay", (c) => c.json({ ok: true, orderId: (c.req.query("order") ?? "").toUpperCase() }));
}