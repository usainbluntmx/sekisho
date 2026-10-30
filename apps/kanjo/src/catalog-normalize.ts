/**
 * Normalización del catálogo extraído (sin red ni base de datos: se prueba offline).
 */

export interface CatalogItem {
  name: string;
  description: string;
  price_atomic: number;
  category: string;
  image_url: string | null;
}

/** Mínimo por producto: 0.01 USDC. */
export const MIN_ATOMIC = 10_000;

/** Minúsculas, sin acentos ni puntuación: compara nombres entre importaciones. */
export function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Precio de la página → unidades atómicas de USDC (6 decimales). Lanza si no es convertible. */
export function toAtomic(price: number, currency: string, fxMxnPerUsdc = Number(process.env.FX_MXN_PER_USDC)): number {
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Precio inválido: ${price}`);
  const code = currency.toUpperCase();
  let usd = price;
  if (code !== "USD" && code !== "USDC") {
    if (code !== "MXN") throw new Error(`Moneda no soportada: ${code}`);
    if (!(fxMxnPerUsdc > 0)) throw new Error("FX_MXN_PER_USDC debe estar definido para precios en MXN");
    usd = price / fxMxnPerUsdc;
  }
  // Redondeo a centavos: así los subtotales que dice el agente suman exactamente el total cobrado
  const atomic = Math.round(usd * 100) * 10_000;
  if (atomic < MIN_ATOMIC) throw new Error(`Precio por debajo de 0.01 USDC: ${price} ${code}`);
  return atomic;
}

/** Solo URLs http(s); las relativas se resuelven contra la página de origen. */
export function resolveImageUrl(value: unknown, sourceUrl: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), sourceUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

interface RawItem {
  name?: unknown;
  description?: unknown;
  price?: unknown;
  category?: unknown;
  image_url?: unknown;
  available?: unknown;
}

export interface NormalizeOptions {
  currency: string;
  sourceUrl: string;
  maxItems: number;
  fxMxnPerUsdc?: number;
}

export function normalizeItems(raw: RawItem[], options: NormalizeOptions): { items: CatalogItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const byName = new Map<string, CatalogItem>();

  for (const item of raw) {
    if (typeof item?.name !== "string" || typeof item?.price !== "number") {
      warnings.push(`Item descartado (sin nombre o precio): ${JSON.stringify(item).slice(0, 80)}`);
      continue;
    }
    if (item.available === false) {
      warnings.push(`Omitido por agotado: ${item.name}`);
      continue;
    }
    const name = item.name.trim().slice(0, 120);
    const key = normalizeName(name);
    if (!key) continue;
    if (byName.has(key)) {
      warnings.push(`Duplicado omitido: ${name}`);
      continue;
    }
    try {
      byName.set(key, {
        name,
        description: typeof item.description === "string" ? item.description.trim().slice(0, 400) : "",
        price_atomic: toAtomic(item.price, options.currency, options.fxMxnPerUsdc),
        category: typeof item.category === "string" ? item.category.trim().slice(0, 60) : "",
        image_url: resolveImageUrl(item.image_url, options.sourceUrl),
      });
    } catch (error) {
      warnings.push(`${name}: ${(error as Error).message}`);
    }
  }

  const items = [...byName.values()];
  if (items.length > options.maxItems) {
    warnings.push(`Recortado a ${options.maxItems} items (llegaron ${items.length})`);
  }
  return { items: items.slice(0, options.maxItems), warnings };
}
