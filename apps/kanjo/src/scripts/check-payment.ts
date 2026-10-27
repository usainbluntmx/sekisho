import { db } from "../db.js";
import { getOrder, getStore } from "../store.js";
import { formatUsdc } from "../money.js";
import { getPaymentMethod } from "../payments/index.js";
import { sekisho } from "../payments/usdc-sekisho.js";
import type { UsdcQuoteDetails } from "../payments/usdc-sekisho.js";

const STORE_ID = process.env.STORE_ID ?? "cafe-kanjo";

const latest = db
  .prepare(
    "SELECT id FROM orders WHERE store_id = ? AND status = 'pending_payment' ORDER BY created_at DESC LIMIT 1"
  )
  .get(STORE_ID) as { id: string } | undefined;

if (!latest) throw new Error("No hay pedidos pendientes. Crea uno en `npm run chat`.");

const store = getStore(STORE_ID)!;
const { order } = getOrder(latest.id)!;

const method = getPaymentMethod();
const quote = await method.createQuote(order, store);
const details = quote.details as UsdcQuoteDetails;

console.log("─────────────────────────────────────────────");
console.log("Pedido:      ", quote.orderId);
console.log("Método:      ", `${method.label} (${quote.methodId})`);
console.log("Total:       ", `${formatUsdc(quote.amountAtomic)} USDC (${quote.amountAtomic} atómico)`);
console.log("Red:         ", details.option.network);
console.log("Factory:     ", sekisho.config.factory);
console.log("payTo:       ", details.vault);
console.log("Monto x402:  ", details.option.price.amount);
console.log("Asset:       ", details.option.price.asset);
console.log("─────────────────────────────────────────────");

const expectedVault = await sekisho.getPayTo(store.merchant_address as `0x${string}`);
console.log("¿payTo = vault de la tienda?:", details.vault === expectedVault);
console.log("¿Monto x402 = total del pedido?:", details.option.price.amount === String(quote.amountAtomic));