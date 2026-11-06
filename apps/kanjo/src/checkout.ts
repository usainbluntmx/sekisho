import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Hono } from "hono";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { toFacilitatorClient } from "@zero-two-labs/sekisho";
import { getOrder, getStore } from "./store.js";
import { facilitator, sekisho } from "./payments/usdc-sekisho.js";
import { renderCheckoutPage, renderNotFound } from "./web/checkout-page.js";
import { endSettlement } from "./settlement-guard.js";
import { blockReason, claimForSettlement, hasValidToken, quoteFor, recordSettledOrder } from "./order-payment.js";

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

/**
 * Diagnóstico de cada intento firmado que termina en 402: motivo exacto que devuelve x402
 * y, si no coinciden, lo que el servidor ofreció contra lo que el cliente firmó.
 */
function logPaymentAttempt(c: Context, orderId: string): void {
  const signature = c.req.header("payment-signature");
  console.log(`[checkout] /api/pay ${orderId} → ${c.res.status} (firma: ${signature ? "sí" : "no"})`);
  if (!signature || c.res.status !== 402) return;

  // Rechazo antes de cobrar (verificación): viene en PAYMENT-REQUIRED
  const requiredHeader = c.res.headers.get("payment-required");
  if (requiredHeader) {
    try {
      const required = decodePaymentRequiredHeader(requiredHeader);
      const payload = decodePaymentSignatureHeader(signature);
      console.warn(
        `[checkout] Pago rechazado en la verificación (pedido ${orderId}): ${required.error ?? "sin motivo"}\n` +
          `  ofrecido: ${JSON.stringify(required.accepts)}\n` +
          `  firmado:  ${JSON.stringify(payload.accepted)}`
      );
    } catch (error) {
      console.warn(`[checkout] No se pudo decodificar PAYMENT-REQUIRED (pedido ${orderId}):`, error);
    }
    return;
  }

  // Falla al liquidar (la firma era válida, pero la transacción no se completó): viene en PAYMENT-RESPONSE
  const responseHeader = c.res.headers.get("payment-response");
  if (responseHeader) {
    try {
      const settle = decodePaymentResponseHeader(responseHeader);
      console.error(
        `[checkout] La liquidación falló (pedido ${orderId}): ${settle.errorReason ?? "sin motivo"}` +
          (settle.errorMessage && settle.errorMessage !== settle.errorReason ? ` · ${settle.errorMessage}` : "") +
          (settle.transaction ? ` · tx ${settle.transaction}` : "") +
          ` · payer ${settle.payer ?? "?"}`
      );
    } catch (error) {
      console.warn(`[checkout] No se pudo decodificar PAYMENT-RESPONSE (pedido ${orderId}):`, error);
    }
    return;
  }

  console.warn(`[checkout] 402 con firma y sin encabezados x402 (pedido ${orderId})`);
}

export function registerCheckout(app: Hono): void {
  const resourceServer = new x402ResourceServer(toFacilitatorClient(facilitator)).register(
    NETWORK,
    new ExactEvmScheme()
  );

  // 0) Diagnóstico: si la verificación rechaza el pago, registrar el motivo exacto
  resourceServer.onAfterVerify(async ({ result, paymentPayload }) => {
    if (result.isValid) return;
    const ctx = paymentContext.getStore();
    const auth = (paymentPayload.payload as { authorization?: { from?: string } }).authorization;
    console.warn(
      `[checkout] Pago rechazado en la verificación (pedido ${ctx?.orderId ?? "?"}): ` +
        `${result.invalidReason ?? "sin motivo"} · payer ${result.payer ?? auth?.from ?? "?"}` +
        (result.invalidMessage ? ` · ${result.invalidMessage}` : "")
    );
  });

  // Diagnóstico: la verificación lanzó una excepción (RPC, firma ilegible, etc.)
  resourceServer.onVerifyFailure(async ({ error }) => {
    const ctx = paymentContext.getStore();
    console.error(`[checkout] La verificación falló con excepción (pedido ${ctx?.orderId ?? "?"}):`, error);
  });

  // Diagnóstico: la liquidación lanzó una excepción (gas, RPC, revert…)
   resourceServer.onSettleFailure(async ({ error }) => {
     const ctx = paymentContext.getStore();
     console.error(`[checkout] La liquidación lanzó una excepción (pedido ${ctx?.orderId ?? "?"}):`, error);
  });

  // A) Justo antes de liquidar: revalidar el pedido y tomar el candado
  resourceServer.onBeforeSettle(async () => {
    const ctx = paymentContext.getStore();
    if (!ctx) return;

    const refused = claimForSettlement(ctx.orderId, ctx.payToken);
    if (refused) return { abort: true as const, reason: refused };
    ctx.ownsSettlement = true;
  });

  // B) Después de liquidar: el dinero ya se movió, así que esto nunca debe perder el registro
  resourceServer.onAfterSettle(async (context) => {
    const ctx = paymentContext.getStore();
    if (!ctx) return;
    recordSettledOrder(ctx.orderId, {
      tx: context.result.transaction,
      payer: context.result.payer,
      amountAtomic: Number(context.requirements.amount),
    });
  });
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
    logPaymentAttempt(c, orderId);
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