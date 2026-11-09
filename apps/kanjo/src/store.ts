import { randomBytes } from "node:crypto";
import { getAddress, isAddress, zeroAddress } from "viem";
import { parseStoredProfile, validateProfile, type StoreProfile } from "./store-profile.js";
import { db } from "./db.js";
import { lineTotalAtomic, toBase, type Unit } from "./units.js";

export interface Store {
  id: string;
  name: string;
  merchant_address: string;
  /** Perfil de negocio ya validado (vacío si la tienda no lo ha llenado). */
  profile: StoreProfile;
  /** draft = armándose · pending = esperando aprobación · published = la ven clientes y agentes. */
  status: StoreStatus;
  /** Quién la dio de alta por chat (tg-… o número de WhatsApp); null en tiendas creadas por consola. */
  owner: string | null;
  /** A quién se avisa de sus pedidos; null = MERCHANT_WA_ID. */
  contact: string | null;
}

export type StoreStatus = "draft" | "pending" | "published";

/** La ven todos si está publicada; su dueño la ve siempre (para probarla antes de publicarla). */
export function isVisibleTo(store: Store, customerId?: string): boolean {
  return store.status === "published" || (Boolean(customerId) && store.owner === customerId);
}

type StoreRow = Omit<Store, "profile"> & { profile: string };
const toStore = (row: StoreRow): Store => ({ ...row, profile: parseStoredProfile(row.profile, row.id) });

export interface Product {
  id: number;
  store_id: string;
  name: string;
  description: string;
  /** Precio por pieza, o por kg si `unit` es "kg". */
  price_atomic: number;
  /** Piezas, o gramos si `unit` es "kg". */
  stock: number;
  active: number;
  unit: Unit;
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
  /** Vencimiento del pedido sin pagar (UTC, "YYYY-MM-DD HH:MM:SS"). Null en pedidos viejos. */
  expires_at: string | null;
  /** "expired" si se canceló por no pagarse a tiempo. */
  cancel_reason: string | null;
}

export interface OrderItem {
  order_id: string;
  product_id: number;
  name: string;
  unit_price_atomic: number;
  /** Piezas, o gramos si `unit` es "kg". */
  quantity: number;
  unit: Unit;
}

export interface OrderItemInput {
  productId: number;
  /** Como lo dice el cliente: piezas, o kg con decimales (0.5 = medio kilo). */
  quantity: number;
}

export interface StockShortage {
  name: string;
  /** En unidades base (piezas o gramos). */
  requested: number;
  available: number;
  unit: Unit;
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

/** Tienda para clientes que todavía no eligieron una (la demo, o la del despliegue). */
export const DEFAULT_STORE_ID = process.env.STORE_ID ?? "cafe-kanjo";

/** Reglas para el id de una tienda: aparece en links, así que solo minúsculas, números y guiones. */
export const STORE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface NewStore {
  id: string;
  name: string;
  merchant: string;
  profile?: unknown;
  status?: StoreStatus;
  owner?: string;
}

/** Palabras que no pueden ser id de tienda porque son comandos (t.me/<bot>?start=vender). */
export const RESERVED_IDS = new Set(["vender", "tienda", "start", "admin", "ayuda"]);

/** Problema de una wallet en palabras simples, o null si sirve para recibir pagos. */
export function walletProblem(input: string): string | null {
  const merchant = input?.trim() ?? "";
  if (!isAddress(merchant, { strict: false })) return "no es una dirección válida (0x + 40 caracteres hexadecimales)";
  if (getAddress(merchant) === zeroAddress) return "la dirección 0x000… no puede recibir pagos";
  if (merchant !== merchant.toLowerCase() && !isAddress(merchant, { strict: true })) {
    return "la dirección tiene mayúsculas que no coinciden con su checksum (¿se copió mal?)";
  }
  return null;
}

/** Valida una tienda nueva sin guardar nada. Devuelve los problemas en palabras simples. */
export function validateNewStore(input: NewStore): string[] {
  const problems: string[] = [];
  const id = input.id?.trim() ?? "";
  if (!STORE_ID_RE.test(id) || id.length < 3 || id.length > 40) {
    problems.push("id: de 3 a 40 caracteres, solo minúsculas, números y guiones (por ejemplo carniceria-don-pepe)");
  } else if (RESERVED_IDS.has(id)) {
    problems.push(`id: "${id}" está reservado; usa otro`);
  } else if (getStore(id)) {
    problems.push(`id: ya existe una tienda "${id}"`);
  }
  const name = input.name?.trim() ?? "";
  if (name.length < 2 || name.length > 80) problems.push("nombre: de 2 a 80 caracteres");
  const wallet = walletProblem(input.merchant);
  if (wallet) problems.push(`wallet del vendedor: ${wallet}`);
  if (input.profile !== undefined) {
    const result = validateProfile(input.profile);
    if (!result.ok) problems.push(...result.problems.map((p) => `perfil · ${p}`));
  }
  return problems;
}

/** Crea la tienda SOLO si todo es válido (en una transacción: o queda completa, o no queda nada). */
export function createStore(input: NewStore): { ok: true; store: Store } | { ok: false; problems: string[] } {
  const problems = validateNewStore(input);
  if (problems.length) return { ok: false, problems };
  const profile = input.profile === undefined ? {} : (validateProfile(input.profile) as { profile: StoreProfile }).profile;
  db.prepare("INSERT INTO stores (id, name, merchant_address, profile, status, owner, contact) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    input.id.trim(),
    input.name.trim(),
    getAddress(input.merchant.trim()),
    JSON.stringify(profile),
    input.status ?? "published",
    input.owner ?? null,
    input.owner ?? null // el dueño recibe los avisos de sus pedidos
  );
  return { ok: true, store: getStore(input.id.trim())! };
}

/** La tienda con la que habla el cliente; si no eligió (o ya no la puede ver), la tienda por defecto. */
export function getCustomerStore(waId: string): Store | undefined {
  const row = db.prepare("SELECT store_id FROM customers WHERE wa_id = ?").get(waId) as { store_id: string | null } | undefined;
  const chosen = row?.store_id ? getStore(row.store_id) : undefined;
  return chosen && isVisibleTo(chosen, waId) ? chosen : getStore(DEFAULT_STORE_ID);
}

/** Cambia la tienda de un cliente. Devuelve false si no existe o el cliente no la puede ver (y no cambia nada). */
export function setCustomerStore(waId: string, storeId: string): boolean {
  const store = getStore(storeId);
  if (!store || !isVisibleTo(store, waId)) return false;
  db.prepare(
    `INSERT INTO customers (wa_id, store_id) VALUES (?, ?)
     ON CONFLICT(wa_id) DO UPDATE SET store_id = excluded.store_id`
  ).run(waId, storeId);
  return true;
}

/** Todas las tiendas (herramientas de consola). Para clientes y agentes, listPublishedStores. */
export function listStores(): Store[] {
  return (db.prepare("SELECT id, name, merchant_address, profile, status, owner, contact FROM stores ORDER BY name").all() as unknown as StoreRow[]).map(toStore);
}

export function listPublishedStores(): Store[] {
  return listStores().filter((s) => s.status === "published");
}

export function listStoresByStatus(status: StoreStatus): Store[] {
  return listStores().filter((s) => s.status === status);
}

export function getStoreByOwner(owner: string): Store | undefined {
  const row = db.prepare("SELECT id, name, merchant_address, profile, status, owner, contact FROM stores WHERE owner = ? LIMIT 1").get(owner) as unknown as StoreRow | undefined;
  return row && toStore(row);
}

export function setStoreStatus(storeId: string, status: StoreStatus): boolean {
  return Number(db.prepare("UPDATE stores SET status = ? WHERE id = ?").run(status, storeId).changes) > 0;
}

/**
 * Borra una tienda que nunca se publicó y no tiene pedidos (alta cancelada). Devuelve false si no se puede.
 * Una tienda publicada o con pedidos nunca se borra.
 */
export function deleteUnpublishedStore(storeId: string): boolean {
  const store = getStore(storeId);
  if (!store || store.status === "published") return false;
  const orders = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE store_id = ?").get(storeId) as { n: number };
  if (Number(orders.n) > 0) return false;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM products WHERE store_id = ?").run(storeId);
    db.prepare("DELETE FROM catalog_imports WHERE store_id = ?").run(storeId);
    db.prepare("UPDATE customers SET store_id = NULL WHERE store_id = ?").run(storeId);
    db.prepare("DELETE FROM stores WHERE id = ?").run(storeId);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Guarda el perfil SOLO si es válido. Devuelve los problemas si no lo es (y no cambia nada). */
export function setStoreProfile(storeId: string, input: unknown): { ok: true; profile: StoreProfile } | { ok: false; problems: string[] } {
  if (!getStore(storeId)) return { ok: false, problems: [`no existe la tienda ${storeId}`] };
  const result = validateProfile(input);
  if (!result.ok) return result;
  db.prepare("UPDATE stores SET profile = ? WHERE id = ?").run(JSON.stringify(result.profile), storeId);
  return result;
}

/** Pedidos sin pagar de los clientes cuyo id empieza con el prefijo (p. ej. "mcp-"). */
export function countPendingOrders(customerPrefix: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending_payment' AND customer_wa_id LIKE ? || '%'")
    .get(customerPrefix) as { n: number };
  return Number(row.n);
}

export function getStore(id: string): Store | undefined {
  const row = db.prepare("SELECT id, name, merchant_address, profile, status, owner, contact FROM stores WHERE id = ?").get(id) as unknown as
    | StoreRow
    | undefined;
  return row && toStore(row);
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

/** Minutos que dura un pedido sin pagar antes de vencer (ORDER_TTL_MINUTES, por defecto 60). */
export function orderTtlMinutes(): number {
  const value = Number(process.env.ORDER_TTL_MINUTES ?? 60);
  return Number.isInteger(value) && value >= 5 && value <= 10_080 ? value : 60;
}

/** Hora de vencimiento de un pedido en milisegundos, o null si no tiene. */
export function expiresAtMs(order: Pick<Order, "expires_at">): number | null {
  return order.expires_at ? Date.parse(`${order.expires_at.replace(" ", "T")}Z`) : null;
}

/** true si el pedido venció: ya cancelado por vencimiento, o pendiente con su hora ya pasada. */
export function isExpired(order: Order, now = Date.now()): boolean {
  if (order.status === "cancelled") return order.cancel_reason === "expired";
  const at = expiresAtMs(order);
  return order.status === "pending_payment" && at !== null && at <= now;
}

/** Importe de una línea del pedido (por kilo, redondeado al centavo). */
export function lineTotal(item: Pick<OrderItem, "unit_price_atomic" | "quantity" | "unit">): number {
  return lineTotalAtomic(item.unit_price_atomic, item.quantity, item.unit);
}

/** Crea un pedido pendiente de pago. Valida productos, cantidades (piezas o kg) y stock. */
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
      const product = getProduct(storeId, input.productId);
      if (!product) throw new Error(`El producto ${input.productId} no existe`);
      let quantity: number;
      try {
        quantity = toBase(input.quantity, product.unit);
      } catch (error) {
        throw new Error(`${product.name}: ${(error as Error).message}`);
      }

      // Suma por producto (por si el mismo producto viene en varias líneas)
      const requested = (requestedByProduct.get(product.id) ?? 0) + quantity;
      if (product.stock < requested) {
        throw new Error(`No hay suficiente stock de ${product.name}`);
      }
      requestedByProduct.set(product.id, requested);

      const line: OrderItem = {
        order_id: orderId,
        product_id: product.id,
        name: product.name,
        unit_price_atomic: product.price_atomic,
        quantity,
        unit: product.unit,
      };
      total += lineTotal(line);
      lines.push(line);
    }

    db.prepare(
      `INSERT INTO orders (id, store_id, customer_wa_id, status, total_atomic, pay_token, expires_at)
       VALUES (?, ?, ?, 'pending_payment', ?, ?, datetime('now', ?))`
    ).run(orderId, storeId, customerWaId, total, randomBytes(16).toString("base64url"), `+${orderTtlMinutes()} minutes`);

    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, name, unit_price_atomic, quantity, unit)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const l of lines) {
      insertItem.run(l.order_id, l.product_id, l.name, l.unit_price_atomic, l.quantity, l.unit);
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
      `SELECT p.name AS name, SUM(oi.quantity) AS requested, p.stock AS available, p.unit AS unit
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ?
       GROUP BY p.id
       HAVING p.stock < SUM(oi.quantity)`
    )
    .all(orderId) as unknown as StockShortage[];
}

/**
 * Cancela los pedidos sin pagar cuya hora ya pasó (los viejos sin expires_at usan created_at + ORDER_TTL_MINUTES).
 * `skip` deja fuera los que tienen un pago en curso. Devuelve los ids vencidos.
 * No hay stock que devolver: el stock solo se descuenta al pagar.
 */
export function expireOrders(skip: (orderId: string) => boolean = () => false): string[] {
  const due = db
    .prepare(
      `SELECT id FROM orders
       WHERE status = 'pending_payment'
         AND COALESCE(expires_at, datetime(created_at, ?)) <= datetime('now')`
    )
    .all(`+${orderTtlMinutes()} minutes`) as { id: string }[];
  const cancel = db.prepare(
    "UPDATE orders SET status = 'cancelled', cancel_reason = 'expired' WHERE id = ? AND status = 'pending_payment'"
  );
  const expired: string[] = [];
  for (const { id } of due) {
    if (skip(id)) continue;
    if (Number(cancel.run(id).changes) > 0) expired.push(id);
  }
  return expired;
}

/**
 * Marca un pedido como pagado y descuenta stock.
 * También acepta un pedido que venció mientras su pago se liquidaba: el dinero ya se movió, así que se honra.
 * Se llama DESPUÉS de que el pago ya se liquidó on-chain, así que nunca debe
 * fallar por stock: si falta, el stock baja hasta 0 y el pedido queda marcado
 * con `stock_issue` para que la tienda lo resuelva (cambio o reembolso).
 */
export function markOrderPaid(orderId: string, paymentTx: string): MarkPaidResult {
  db.exec("BEGIN");
  try {
    const result = db
      .prepare(
        `UPDATE orders SET status = 'paid', payment_tx = ?, paid_at = datetime('now'), cancel_reason = NULL
         WHERE id = ? AND (status = 'pending_payment' OR (status = 'cancelled' AND cancel_reason = 'expired'))`
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