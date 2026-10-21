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

    for (const input of inputs) {
      if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
        throw new Error("Cantidad inválida");
      }
      const product = getProduct(storeId, input.productId);
      if (!product) throw new Error(`El producto ${input.productId} no existe`);
      if (product.stock < input.quantity) {
        throw new Error(`No hay suficiente stock de ${product.name}`);
      }

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
      `INSERT INTO orders (id, store_id, customer_wa_id, status, total_atomic)
       VALUES (?, ?, ?, 'pending_payment', ?)`
    ).run(orderId, storeId, customerWaId, total);

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

/**
 * Marca un pedido como pagado y descuenta stock.
 * Devuelve false si el pedido no existía o ya no estaba pendiente.
 */
export function markOrderPaid(orderId: string, paymentTx: string): boolean {
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
      return false;
    }

    const items = db
      .prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?")
      .all(orderId) as unknown as Pick<OrderItem, "product_id" | "quantity">[];

    const decrement = db.prepare("UPDATE products SET stock = stock - ? WHERE id = ?");
    for (const item of items) decrement.run(item.quantity, item.product_id);

    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}