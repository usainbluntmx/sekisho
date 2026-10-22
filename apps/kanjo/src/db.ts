import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "data/kanjo.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS stores (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    merchant_address TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id     TEXT NOT NULL REFERENCES stores(id),
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    price_atomic INTEGER NOT NULL CHECK (price_atomic > 0),
    stock        INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    active       INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS customers (
    wa_id      TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id             TEXT PRIMARY KEY,
    store_id       TEXT NOT NULL REFERENCES stores(id),
    customer_wa_id TEXT NOT NULL REFERENCES customers(wa_id),
    status         TEXT NOT NULL CHECK (status IN ('pending_payment', 'paid', 'cancelled')),
    total_atomic   INTEGER NOT NULL,
    payment_tx     TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at        TEXT
  );

  CREATE TABLE IF NOT EXISTS order_items (
    order_id          TEXT NOT NULL REFERENCES orders(id),
    product_id        INTEGER NOT NULL REFERENCES products(id),
    name              TEXT NOT NULL,
    unit_price_atomic INTEGER NOT NULL,
    quantity          INTEGER NOT NULL CHECK (quantity > 0)
  );

  -- Registro de cada liquidación on-chain (una fila por transacción)
  CREATE TABLE IF NOT EXISTS payments (
    tx            TEXT PRIMARY KEY,
    order_id      TEXT NOT NULL REFERENCES orders(id),
    payer         TEXT,
    amount_atomic INTEGER NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('order', 'duplicate')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─────────────── Migraciones ligeras ───────────────

function hasColumn(table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return columns.some((c) => c.name === column);
}

// Faltantes de stock detectados al pagar (JSON), o NULL si no hubo
if (!hasColumn("orders", "stock_issue")) {
  db.exec("ALTER TABLE orders ADD COLUMN stock_issue TEXT");
}