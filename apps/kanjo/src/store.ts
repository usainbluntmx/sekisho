import { randomBytes } from "node:crypto";
import { db } from "./db.js";

export interface Store {
  id: string;
  name: string;
  merchant_address: string;
}

export interface Product {
  id: number;
  store_id: string;
  name: string;
  description: string;
  price_atomic: number;
  stock: number;
  active: number;
  /** Sección del menú (vacía si no se importó). */
  category: string;
  image_url: string | null;
}

export interface Order {
  id: string;
  store_id: string;
  customer_wa_id: string;
  status: "pending_payment" | "paid" | "cancelled";
  total_atomic: number;
  payment_tx: string | null;
  created_at: string;
  paid_at: string | null;
  /** JSON con los faltantes de stock detectados al pagar, o null. */
  stock_issue: string | null;
  /** Token secreto del link de pago. */
  pay_token: string | null;
}

export interface OrderItem {
  order_id: string;
  product_id: number;
  name: string;
  unit_price_atomic: number;
  quantity: number;
}

export interface OrderItemInput {
  productId: number;
  quantity: number;
}

export interface StockShortage {
  name: string;
  requested: number;
  available: number;
}

export interface MarkPaidResult {
  /** false si el pedido no existía o ya no estaba pendiente. */
  updated: boolean;
  shortages: StockShortage[];
}

export interface PaymentRecord {
  tx: string;
  orderId: string;
  payer?: string;
  amountAtomic: number;
  kind: "order" | "duplicate";
}

// ─────────────── Tienda y catálogo ───────────────

export function getStore(id: string): Store | undefined {
  return db
    .prepare("SELECT id, name, merchant_address FROM stores WHERE id = ?")
    .get(id) as unknown as Store | undefined;
}

export function listProducts(storeId: string): Product[] {
  return db
    .prepare("SELECT * FROM products WHERE store_id = ? AND active = 1 ORDER BY id")
    .all(storeId) as unknown as Product[];
}

export function getProduct(storeId: string, productId: number): Product | undefined {
  return db
    .prepare("SELECT * FROM products WHERE id = ? AND store_id = ? AND active = 1")
    .get(productId, storeId) as unknown as Product | undefined;
}

// ─────────────── Clientes ───────────────

export function upsertCustomer(waId: string, name: string): void {
  db.prepare(
    `INSERT INTO customers (wa_id, name) VALUES (?, ?)
     ON CONFLICT(wa_id) DO UPDATE SET name = excluded.name`
  ).run(waId, name);
}

// ─────────────── Pedidos ───────────────

export function getOrder(orderId: string): { order: Order; items: OrderItem[] } | undefined {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as unknown as
    | Order
    | undefined;
  if (!order) return undefined;

  const items = db
    .prepare("SELECT * FROM order_items WHERE order_id = ?")
    .all(orderId) as unknown as OrderItem[];
  return { order, items };
}

/** Crea un pedido pendiente de pago. Valida productos, cantidades y stock. */
export function createOrder(
  storeId: string,
  customerWaId: string,
  inputs: OrderItemInput[]
): { order: Order; items: OrderItem[] } {
  if (inputs.length === 0) throw new Error("El pedido está vacío");

  const orderId = randomBytes(4).toString("hex").toUpperCase();

  db.exec("BEGIN");
  try {
    let total = 0;
    const lines: OrderItem[] = [];
    const requestedByProduct = new Map<number, number>();

    for (const input of inputs) {
      if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
        throw new Error("Cantidad inválida");
      }
      const product = getProduct(storeId, input.productId);
      if (!product) throw new Error(`El producto ${input.productId} no existe`);

      // Suma por producto (por si el mismo producto viene en varias líneas)
      const requested = (requestedByProduct.get(product.id) ?? 0) + input.quantity;
      if (product.stock < requested) {
        throw new Error(`No hay suficiente stock de ${product.name}`);
      }
      requestedByProduct.set(product.id, requested);

      total += product.price_atomic * input.quantity;
      lines.push({
        order_id: orderId,
        product_id: product.id,
        name: product.name,
        unit_price_atomic: product.price_atomic,
        quantity: input.quantity,
      });
    }

    db.prepare(
      `INSERT INTO orders (id, store_id, customer_wa_id, status, total_atomic, pay_token)
       VALUES (?, ?, ?, 'pending_payment', ?, ?)`
    ).run(orderId, storeId, customerWaId, total, randomBytes(16).toString("base64url"));

    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, name, unit_price_atomic, quantity)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const l of lines) {
      insertItem.run(l.order_id, l.product_id, l.name, l.unit_price_atomic, l.quantity);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getOrder(orderId)!;
}

/** Productos del pedido que hoy no tienen stock suficiente. */
export function getStockShortages(orderId: string): StockShortage[] {
  return db
    .prepare(
      `SELECT p.name AS name, SUM(oi.quantity) AS requested, p.stock AS available
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ?
       GROUP BY p.id
       HAVING p.stock < SUM(oi.quantity)`
    )
    .all(orderId) as unknown as StockShortage[];
}

/**
 * Marca un pedido como pagado y descuenta stock.
 * Se llama DESPUÉS de que el pago ya se liquidó on-chain, así que nunca debe
 * fallar por stock: si falta, el stock baja hasta 0 y el pedido queda marcado
 * con `stock_issue` para que la tienda lo resuelva (cambio o reembolso).
 */
export function markOrderPaid(orderId: string, paymentTx: string): MarkPaidResult {
  db.exec("BEGIN");
  try {
    const result = db
      .prepare(
        `UPDATE orders SET status = 'paid', payment_tx = ?, paid_at = datetime('now')
         WHERE id = ? AND status = 'pending_payment'`
      )
      .run(paymentTx, orderId);

    if (Number(result.changes) === 0) {
      db.exec("ROLLBACK");
      return { updated: false, shortages: [] };
    }

    const shortages = getStockShortages(orderId);

    const items = db
      .prepare(
        "SELECT product_id, SUM(quantity) AS quantity FROM order_items WHERE order_id = ? GROUP BY product_id"
      )
      .all(orderId) as unknown as { product_id: number; quantity: number }[];

    const decrement = db.prepare("UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ?");
    for (const item of items) decrement.run(item.quantity, item.product_id);

    if (shortages.length > 0) {
      db.prepare("UPDATE orders SET stock_issue = ? WHERE id = ?").run(
        JSON.stringify(shortages),
        orderId
      );
    }

    db.exec("COMMIT");
    return { updated: true, shortages };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ─────────────── Pagos ───────────────

/** Registra una liquidación. Idempotente: la misma tx no se registra dos veces. */
export function recordPayment(payment: PaymentRecord): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO payments (tx, order_id, payer, amount_atomic, kind)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(payment.tx, payment.orderId, payment.payer ?? null, payment.amountAtomic, payment.kind);
  return Number(result.changes) > 0;
}