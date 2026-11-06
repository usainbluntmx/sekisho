/**
 * Catálogo desde un archivo JSON que edita la tienda (para negocios sin página web).
 * Se valida completo antes de guardar nada: un campo mal escrito, un precio en cero o un
 * peso con demasiados decimales se rechaza con una explicación, y la tienda queda como estaba.
 */
import { z } from "zod";
import { normalizeName, toAtomic, type CatalogItem } from "./catalog-normalize.js";

export const MAX_FILE_ITEMS = 200;

const itemSchema = z
  .object({
    name: z.string().trim().min(1, "falta el nombre").max(120, "máximo 120 caracteres"),
    price: z.number({ error: "debe ser un número (sin $ ni comas)" }).positive("debe ser mayor a 0"),
    unit: z.enum(["pieza", "kg"]).default("pieza"),
    stock: z.number({ error: "debe ser un número" }).min(0, "no puede ser negativo").optional(),
    category: z.string().trim().max(60, "máximo 60 caracteres").default(""),
    description: z.string().trim().max(400, "máximo 400 caracteres").default(""),
    image_url: z.string().trim().url("debe ser una URL completa (https://…)").optional(),
  })
  .strict();

const fileSchema = z
  .object({
    currency: z.enum(["MXN", "USD", "USDC"]).default("MXN"),
    items: z.array(itemSchema).min(1, "el catálogo no tiene productos").max(MAX_FILE_ITEMS, `máximo ${MAX_FILE_ITEMS} productos`),
  })
  .strict();

export type CatalogFile = z.input<typeof fileSchema>;

const FIELD_NAMES: Record<string, string> = {
  name: "nombre",
  price: "precio",
  unit: "unidad",
  stock: "existencias (stock)",
  category: "sección",
  description: "descripción",
  image_url: "foto",
  currency: "moneda",
  items: "productos",
};

export type CatalogFileResult =
  | { ok: true; currency: string; items: CatalogItem[] }
  | { ok: false; problems: string[] };

/** Valida el archivo y lo convierte a productos listos para el diff (precios en USDC atómico, stock en unidades base). */
export function parseCatalogFile(input: unknown, fxMxnPerUsdc = Number(process.env.FX_MXN_PER_USDC)): CatalogFileResult {
  const parsed = fileSchema.safeParse(input);
  const raw = (input as { items?: { name?: unknown }[] })?.items;
  const label = (index: number) => {
    const name = raw?.[index]?.name;
    return `producto ${index + 1}${typeof name === "string" && name.trim() ? ` (${name.trim()})` : ""}`;
  };

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const [top, index, field] = issue.path;
      const where = top === "items" && typeof index === "number" ? `${label(index)} · ` : "";
      if (issue.code === "unrecognized_keys") return `${where}campos que no existen: ${issue.keys.join(", ")}`;
      const name = FIELD_NAMES[String(field ?? top)] ?? String(field ?? top ?? "catálogo");
      if (issue.code === "invalid_value" && "values" in issue) return `${where}${name}: debe ser uno de ${(issue.values as string[]).join(", ")}`;
      return `${where}${name}: ${issue.message}`;
    });
    return { ok: false, problems };
  }

  // Sin tipo de cambio no se puede convertir ningún precio en MXN: un solo aviso, no uno por producto
  if (parsed.data.currency === "MXN" && !(fxMxnPerUsdc > 0)) {
    return { ok: false, problems: ["moneda: los precios están en MXN y falta FX_MXN_PER_USDC (pesos por 1 USDC, por ejemplo 18.5) en .env"] };
  }

  const problems: string[] = [];
  const seen = new Map<string, number>();
  const items: CatalogItem[] = [];
  parsed.data.items.forEach((item, index) => {
    const key = normalizeName(item.name);
    if (seen.has(key)) {
      problems.push(`${label(index)} · nombre repetido (igual al producto ${seen.get(key)! + 1}); cada producto va una sola vez`);
      return;
    }
    seen.set(key, index);
    try {
      let stock: number | undefined;
      if (item.stock !== undefined) {
        // 0 es válido (agotado)
        stock = item.stock === 0 ? 0 : item.unit === "kg" ? stockGrams(item.stock) : stockPieces(item.stock);
      }
      items.push({
        name: item.name,
        description: item.description,
        price_atomic: toAtomic(item.price, parsed.data.currency, fxMxnPerUsdc),
        unit: item.unit,
        category: item.category,
        image_url: item.image_url ?? null,
        ...(stock !== undefined ? { stock } : {}),
      });
    } catch (error) {
      problems.push(`${label(index)} · ${(error as Error).message}`);
    }
  });

  return problems.length ? { ok: false, problems } : { ok: true, currency: parsed.data.currency, items };
}

function stockPieces(value: number): number {
  if (!Number.isInteger(value)) throw new Error("existencias: las piezas van en números enteros");
  return value;
}

function stockGrams(value: number): number {
  const grams = Math.round(value * 1000);
  if (Math.abs(value * 1000 - grams) > 1e-6) throw new Error("existencias: usa kilos con hasta 3 decimales (2.5 = 2 kg 500 g)");
  return grams;
}
