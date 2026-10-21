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
`);