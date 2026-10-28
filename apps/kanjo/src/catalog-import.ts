import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { CATALOG_PROMPT, CATALOG_SCHEMA } from "./catalog-schema.js";
import { normalizeItems, normalizeName, type CatalogItem } from "./catalog-normalize.js";

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";

export interface CatalogDiff {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
}

export interface CatalogPreview {
  id: string;
  store_id: string;
  source_url: string;
  currency: string;
  store_name: string | null;
  items: CatalogItem[];
  diff: CatalogDiff;
  warnings: string[];
}

db.exec(`
  CREATE TABLE IF NOT EXISTS catalog_imports (
    id         TEXT PRIMARY KEY,
    store_id   TEXT NOT NULL REFERENCES stores(id),
    source_url TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('preview','applied')),
    currency   TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    applied_at TEXT
  );
`);

interface ExistingProduct {
  id: number;
  name: string;
  description: string;
  price_atomic: number;
  category: string | null;
  image_url: string | null;
}

function activeProducts(storeId: string): ExistingProduct[] {
  return db
    .prepare(
      "SELECT id, name, description, price_atomic, category, image_url FROM products WHERE store_id = ? AND active = 1"
    )
    .all(storeId) as unknown as ExistingProduct[];
}

/** Diff contra lo que ya está en la base, sin escribir nada. */
export function diffAgainstStore(storeId: string, items: CatalogItem[]): CatalogDiff {
  const existing = activeProducts(storeId);
  const current = new Map(existing.map((p) => [normalizeName(p.name), p]));
  const incoming = new Set(items.map((i) => normalizeName(i.name)));

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const item of items) {
    const found = current.get(normalizeName(item.name));
    if (!found) added++;
    else if (
      found.price_atomic !== item.price_atomic ||
      found.description !== item.description ||
      (found.category ?? "") !== item.category ||
      (found.image_url ?? null) !== item.image_url
    ) updated++;
    else unchanged++;
  }
  const removed = existing.filter((p) => !incoming.has(normalizeName(p.name))).length;
  return { added, updated, unchanged, removed };
}

/** Paso 1: trae la página con Firecrawl, extrae, normaliza y guarda el preview. No toca products. */
export async function previewCatalog(storeId: string, url: string): Promise<CatalogPreview> {
  const apiKey = process.env.FIRECRAWL_API_KEY ?? "";
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY no está configurada");
  if (!/^https?:\/\//i.test(url)) throw new Error("La URL debe empezar con http:// o https://");

  const res = await fetch(FIRECRAWL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      // En menús los productos suelen vivir en grillas o <nav>; el filtro de contenido principal los tira
      onlyMainContent: false,
      // Firecrawl guarda en caché hasta 2 días por defecto (incluso una página que dio 404):
      // un catálogo debe leerse fresco, así que por defecto no se usa caché
      maxAge: Number(process.env.CATALOG_CACHE_MS ?? 0),
      formats: [{ type: "json", schema: CATALOG_SCHEMA, prompt: CATALOG_PROMPT }],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok || body?.success === false) {
    throw new Error(`Firecrawl ${res.status}: ${body?.error ?? "sin detalle"}`);
  }

  // La página misma respondió con error (404, 500…): Firecrawl lo informa en metadata.statusCode
  const pageStatus = Number(body?.data?.metadata?.statusCode ?? 200);
  if (pageStatus >= 400) throw new Error(`La página respondió ${pageStatus}; revisa que la URL esté publicada`);

  // Firecrawl v2 devuelve la extracción en data.json
  const extracted = body?.data?.json ?? null;
  if (!extracted || !Array.isArray(extracted.items)) {
    throw new Error(`La página no produjo un catálogo. Llaves recibidas: ${Object.keys(body?.data ?? {}).join(", ")}`);
  }

  const currency = String(extracted.currency ?? "MXN").toUpperCase();
  const { items, warnings } = normalizeItems(extracted.items, {
    currency,
    sourceUrl: url,
    maxItems: Number(process.env.CATALOG_MAX_ITEMS ?? 200),
  });
  if (items.length === 0) throw new Error(`No se extrajo ningún producto con precio. ${warnings.slice(0, 3).join(" · ")}`);

  const diff = diffAgainstStore(storeId, items);
  const id = randomBytes(4).toString("hex").toUpperCase();
  const storeName = typeof extracted.store_name === "string" ? extracted.store_name : null;

  db.prepare(
    `INSERT INTO catalog_imports (id, store_id, source_url, status, currency, payload)
     VALUES (?, ?, ?, 'preview', ?, ?)`
  ).run(id, storeId, url, currency, JSON.stringify({ items, warnings, diff, store_name: storeName }));

  return { id, store_id: storeId, source_url: url, currency, store_name: storeName, items, diff, warnings };
}

/** Paso 2: aplica un preview. Idempotente: un import ya aplicado no se repite. */
export function applyCatalog(importId: string, mode: "merge" | "replace" = "merge"): { added: number; updated: number; deactivated: number } {
  const row = db
    .prepare("SELECT id, store_id, payload FROM catalog_imports WHERE id = ? AND status = 'preview'")
    .get(importId.toUpperCase()) as unknown as { id: string; store_id: string; payload: string } | undefined;
  if (!row) throw new Error("Importación no encontrada o ya aplicada");

  const { items } = JSON.parse(row.payload) as { items: CatalogItem[] };
  const existing = activeProducts(row.store_id);
  const current = new Map(existing.map((p) => [normalizeName(p.name), p]));
  const stock = Number(process.env.CATALOG_DEFAULT_STOCK ?? 20);

  let added = 0;
  let updated = 0;
  let deactivated = 0;
  db.exec("BEGIN");
  try {
    const insert = db.prepare(
      "INSERT INTO products (store_id, name, description, price_atomic, stock, category, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const update = db.prepare(
      "UPDATE products SET name = ?, description = ?, price_atomic = ?, category = ?, image_url = ? WHERE id = ?"
    );
    for (const item of items) {
      const found = current.get(normalizeName(item.name));
      if (found) {
        update.run(item.name, item.description, item.price_atomic, item.category, item.image_url, found.id);
        updated++;
      } else {
        insert.run(row.store_id, item.name, item.description, item.price_atomic, stock, item.category, item.image_url);
        added++;
      }
    }

    if (mode === "replace") {
      const keep = new Set(items.map((i) => normalizeName(i.name)));
      const deactivate = db.prepare("UPDATE products SET active = 0 WHERE id = ?");
      for (const p of existing) {
        if (!keep.has(normalizeName(p.name))) {
          deactivate.run(p.id);
          deactivated++;
        }
      }
    }

    db.prepare("UPDATE catalog_imports SET status = 'applied', applied_at = datetime('now') WHERE id = ?").run(row.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { added, updated, deactivated };
}
