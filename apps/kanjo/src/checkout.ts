import { AsyncLocalStorage } from "node:async_hooks";
import type { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { toFacilitatorClient } from "@zero-two-labs/sekisho";
import {
  getOrder,
  getStockShortages,
  getStore,
  markOrderPaid,
  recordPayment,
  type PaymentRecord,
} from "./store.js";
import { getPaymentMethod } from "./payments/index.js";
import { facilitator, sekisho, type UsdcQuoteDetails } from "./payments/usdc-sekisho.js";
import { renderCheckoutPage, renderNotFound } from "./web/checkout-page.js";
import { enqueueDuplicatePayment, enqueueOrderPaid } from "./notify.js";
import { processOutbox } from "./outbox.js";
import { endSettlement, isSettling, tryStartSettlement } from "./settlement-guard.js";
import { safeEqual } from "./security.js";

const STORE_ID = process.env.STORE_ID ?? "cafe-kanjo";
const NETWORK = `eip155:${sekisho.config.chain.id}` as const;
const EXPLORER = sekisho.config.explorer;

/** Datos de la petición de pago en curso (disponibles en los hooks de liquidación). */
interface PaymentContext {
  orderId: string;
  payToken: string;
  /** true si esta petición tomó el candado de liquidación del pedido. */
  ownsSettlement: boolean;
}
const paymentContext = new AsyncLocalStorage<PaymentContext>();

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

/** true si el token corresponde al pedido (sin token válido, el pedido "no existe"). */
function hasValidToken(orderId: string, token: string): boolean {
  const found = getOrder(orderId);
  return Boolean(found?.order.pay_token && token && safeEqual(token, found.order.pay_token));
}

interface BlockReason {
  status: 404 | 409;
  error: string;
}

/** Motivo por el que un pedido no se puede cobrar en este momento, o null si sí se puede. */
function blockReason(orderId: string, token: string): BlockReason | null {
  if (!hasValidToken(orderId, token)) return { status: 404, error: "Pedido no encontrado." };

  const found = getOrder(orderId)!;
  if (found.order.status !== "pending_payment") {
    return { status: 409, error: "Este pedido ya fue pagado o ya no está disponible." };
  }

  if (isSettling(orderId)) {
    return { status: 409, error: "Ya hay un pago en proceso para este pedido. Espera unos segundos." };
  }

  const shortages = getStockShortages(orderId);
  if (shortages.length > 0) {
    const names = shortages.map((s) => `${s.name} (quedan ${s.available})`).join(", ");
    return {
      status: 409,
      error: `Sin stock suficiente: ${names}. Pide al asistente que ajuste tu pedido.`,
    };
  }

  return null;
}

function recordSafely(payment: PaymentRecord): void {
  try {
    recordPayment(payment);
  } catch (error) {
    console.error(`[checkout] No se pudo registrar el pago ${payment.tx}:`, error);
  }
}

/** Tareas posteriores al pago: reparto (según el modo) y avisos por la bandeja de salida. */
async function afterOrderPaid(orderId: string, tx: string): Promise<void> {
  const found = getOrder(orderId);
  const store = getStore(STORE_ID);
  if (!found || !store) return;

  try {
    enqueueOrderPaid(orderId);
    void processOutbox();
  } catch (error) {
    console.error("[checkout] No se pudieron encolar los avisos (se recuperan al reiniciar):", error);
  }

  try {
    await getPaymentMethod().afterPaid?.(found.order, store, tx);
  } catch (error) {
    console.error("[checkout] El reparto falló (el distributor lo recupera):", error);
  }
}

export function registerCheckout(app: Hono): void {
  const resourceServer = new x402ResourceServer(toFacilitatorClient(facilitator)).register(
    NETWORK,
    new ExactEvmScheme()
  );

  // A) Justo antes de liquidar: revalidar el pedido y tomar el candado
  resourceServer.onBeforeSettle(async () => {
    const ctx = paymentContext.getStore();
    if (!ctx) return;

    const blocked = blockReason(ctx.orderId, ctx.payToken);
    if (blocked) {
      console.warn(`[checkout] Liquidación cancelada para ${ctx.orderId}: ${blocked.error}`);
      return { abort: true as const, reason: blocked.error };
    }

    if (!tryStartSettlement(ctx.orderId)) {
      return { abort: true as const, reason: "Ya hay un pago en proceso para este pedido." };
    }
    ctx.ownsSettlement = true;
  });

  // B) Después de liquidar: el dinero ya se movió, así que esto nunca debe perder el registro
  resourceServer.onAfterSettle(async (context) => {
    const ctx = paymentContext.getStore();
    if (!ctx) return;

    const { orderId } = ctx;
    const tx = context.result.transaction;
    const base = {
      tx,
      orderId,
      payer: context.result.payer,
      amountAtomic: Number(context.requirements.amount),
    };

    let result: ReturnType<typeof markOrderPaid>;
    try {
      result = markOrderPaid(orderId, tx);
    } catch (error) {
      console.error(
        `[checkout] CRÍTICO: el pago ${tx} se liquidó pero el pedido ${orderId} no se pudo actualizar`,
        error
      );
      recordSafely({ ...base, kind: "order" });
      return;
    }

    if (!result.updated) {
      recordSafely({ ...base, kind: "duplicate" });
      console.warn(`[checkout] Pago duplicado del pedido ${orderId} → ${EXPLORER}/tx/${tx}`);
      try {
        enqueueDuplicatePayment(orderId, tx, base.amountAtomic);
        void processOutbox();
      } catch (error) {
        console.error("[checkout] No se pudo encolar el aviso de duplicado:", error);
      }
      return;
    }

    recordSafely({ ...base, kind: "order" });
    console.log(`[checkout] Pedido ${orderId} pagado → ${EXPLORER}/tx/${tx}`);
    if (result.shortages.length > 0) {
      console.warn(`[checkout] Pedido ${orderId} pagado SIN stock suficiente:`, result.shortages);
    }

    void afterOrderPaid(orderId, tx);
  });

  // 1) Página de pago (requiere el token del link)
  app.get("/pay/:orderId", (c) => {
    const orderId = c.req.param("orderId").toUpperCase();
    const token = c.req.query("t") ?? "";
    const store = getStore(STORE_ID);

    if (!store || !hasValidToken(orderId, token)) return c.html(renderNotFound(), 404);
    const found = getOrder(orderId)!;

    return c.html(
      renderCheckoutPage({
        store,
        order: found.order,
        items: found.items,
        usdc: sekisho.config.usdc,
        explorer: EXPLORER,
        payToken: token,
      })
    );
  });

  // 2) Validación previa al cobro (antes de pedir la firma) y liberación del candado al terminar
  app.use("/api/pay", async (c, next) => {
    const orderId = (c.req.query("order") ?? "").toUpperCase();
    const token = c.req.query("t") ?? "";

    const blocked = blockReason(orderId, token);
    if (blocked) return c.json({ error: blocked.error }, blocked.status);

    // Si la red no responde, avisar con 503 en lugar de un error genérico
    try {
      await quoteFor(orderId);
    } catch (error) {
      console.error(`[checkout] No se pudo cotizar ${orderId} (¿RPC caído?):`, error);
      return c.json(
        { error: "El servicio de pagos no está disponible en este momento. Intenta de nuevo en unos minutos." },
        503
      );
    }

    const ctx: PaymentContext = { orderId, payToken: token, ownsSettlement: false };
    try {
      await paymentContext.run(ctx, () => next());
    } finally {
      if (ctx.ownsSettlement) endSettlement(orderId);
    }
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