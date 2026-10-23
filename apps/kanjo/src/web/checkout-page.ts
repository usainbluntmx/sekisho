import type { Order, OrderItem, Store } from "../store.js";
import { formatUsdc } from "../money.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f6f6f4; color: #1a1a1a; margin: 0; }
    main { max-width: 420px; margin: 40px auto; padding: 0 16px; }
    .card { background: #fff; border-radius: 16px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,.06); }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .muted { color: #666; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 15px; }
    td { padding: 6px 0; } td:last-child { text-align: right; }
    .total td { border-top: 1px solid #eee; font-weight: 700; padding-top: 12px; }
    button { width: 100%; padding: 14px; border: 0; border-radius: 12px; background: #e84142; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .6; cursor: default; }
    #status { margin-top: 16px; font-size: 14px; line-height: 1.5; word-break: break-word; }
    a { color: #e84142; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export interface CheckoutPageData {
  store: Store;
  order: Order;
  items: OrderItem[];
  usdc: string;
  explorer: string;
  payToken: string;
}

export function renderCheckoutPage({ store, order, items, usdc, explorer, payToken }: CheckoutPageData): string {
  const rows = items
    .map(
      (i) =>
        `<tr><td>${i.quantity} × ${escapeHtml(i.name)}</td><td>${formatUsdc(i.unit_price_atomic * i.quantity)} USDC</td></tr>`
    )
    .join("");

  const paid = order.status === "paid";

  const action = paid
    ? `<p>✅ Este pedido ya está pagado.</p>
       ${order.payment_tx ? `<p class="muted"><a href="${explorer}/tx/${order.payment_tx}" target="_blank">Ver transacción</a></p>` : ""}`
    : order.status === "cancelled"
      ? `<p>Este pedido fue cancelado.</p>`
      : `<button id="pay-button">Pagar ${formatUsdc(order.total_atomic)} USDC</button>
         <div id="status" class="muted">Paga con tu wallet en Avalanche. Solo firmas, sin pagar gas.</div>
         <script type="module" src="/public/checkout.js"></script>`;

  return layout(
    `Pagar pedido ${order.id}`,
    `<div class="card" id="checkout"
        data-order-id="${order.id}"
        data-pay-token="${escapeHtml(payToken)}"
        data-amount="${order.total_atomic}"
        data-asset="${usdc}"
        data-explorer="${explorer}">
      <h1>${escapeHtml(store.name)}</h1>
      <div class="muted">Pedido ${order.id}</div>
      <table>
        ${rows}
        <tr class="total"><td>Total</td><td>${formatUsdc(order.total_atomic)} USDC</td></tr>
      </table>
      ${action}
    </div>`
  );
}

export function renderNotFound(): string {
  return layout(
    "Pedido no encontrado",
    `<div class="card"><h1>Pedido no encontrado</h1><p class="muted">Revisa el link que te enviamos por WhatsApp.</p></div>`
  );
}