/**
 * Catálogo escrito en el chat, un producto por renglón:
 *   Nombre, precio[, kg][, existencias]
 *   Arrachera, 380, kg, 10
 *   Martillo de uña, 185, 6
 * Se convierte al formato de archivo y se valida con las mismas reglas (parseCatalogFile).
 */
import { parseCatalogFile, type CatalogFileResult } from "./catalog-file.js";

export const MAX_LINES = 100;

/** "$1,200.50" no se acepta (la coma separa campos); "$180", "180 mxn", "180.5" sí. */
function cleanPrice(raw: string): number | string {
  const value = raw.replace(/\$|mxn|pesos/gi, "").trim();
  return /^\d+(\.\d+)?$/.test(value) ? Number(value) : raw.trim();
}

export function parseCatalogLines(text: string, fxMxnPerUsdc?: number): CatalogFileResult {
  const lines = text
    .split("\n")
    .map((l) => l.trim().replace(/^[-•*]\s*/, ""))
    .filter(Boolean);
  if (lines.length === 0) return { ok: false, problems: ["no encontré productos: manda uno por renglón"] };
  if (lines.length > MAX_LINES) return { ok: false, problems: [`máximo ${MAX_LINES} productos por mensaje`] };

  const problems: string[] = [];
  const items = lines.map((line, index) => {
    const [name, price, ...rest] = line.split(",").map((f) => f.trim());
    const item: Record<string, unknown> = { name: name ?? "", price: price === undefined ? undefined : cleanPrice(price) };
    for (const token of rest) {
      const t = token.toLowerCase();
      if (["kg", "kilo", "kilos", "por kg", "por kilo"].includes(t)) item.unit = "kg";
      else if (["pieza", "piezas", "pza", "pzas"].includes(t)) item.unit = "pieza";
      else if (/^\d+(\.\d+)?$/.test(t)) item.stock = Number(t);
      else problems.push(`producto ${index + 1} (${name}) · no entendí "${token}" (va kg, pieza o un número de existencias)`);
    }
    if (price === undefined) problems.push(`producto ${index + 1} (${name}) · falta el precio: Nombre, precio`);
    return item;
  });
  if (problems.length) return { ok: false, problems };

  // Sin existencias: las de siempre (CATALOG_DEFAULT_STOCK piezas o kilos)
  const stock = Number(process.env.CATALOG_DEFAULT_STOCK ?? 20);
  for (const item of items) item.stock ??= stock;
  return parseCatalogFile({ currency: "MXN", items }, fxMxnPerUsdc);
}

/** Las líneas de ejemplo de una plantilla, listas para copiar y editar. */
export function linesFromTemplate(items: { name: string; price: number; unit?: string; stock?: number }[]): string {
  return items.map((i) => [i.name, i.price, i.unit === "kg" ? "kg" : null, i.stock ?? null].filter((x) => x !== null).join(", ")).join("\n");
}
