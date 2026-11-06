/**
 * Unidades de venta: por pieza o por kilo.
 * Por dentro, las cantidades son enteros en "unidades base": piezas, o GRAMOS para lo que se vende por kg.
 * Así el stock y los pedidos nunca acumulan errores de decimales.
 */
import { formatUsdc } from "./money.js";

export type Unit = "pieza" | "kg";
export const UNITS: readonly Unit[] = ["pieza", "kg"];

export const MAX_PIECES = 100;
/** Mínimo por línea de un producto por kilo: 50 g. */
export const MIN_GRAMS = 50;
/** Máximo por línea de un producto por kilo: 100 kg. */
export const MAX_GRAMS = 100_000;

/** Un centavo de USDC en unidades atómicas. */
const CENT = 10_000;

export function isUnit(value: unknown): value is Unit {
  return value === "pieza" || value === "kg";
}

/**
 * Cantidad como la dice el cliente (piezas, o kg con decimales) → unidades base.
 * Lanza un error en palabras simples si no es válida.
 */
export function toBase(quantity: number, unit: Unit): number {
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Cantidad inválida");
  }
  if (unit === "pieza") {
    if (!Number.isInteger(quantity)) throw new Error("Cantidad inválida: las piezas van en números enteros (1, 2, 3…)");
    if (quantity > MAX_PIECES) throw new Error(`Cantidad inválida: máximo ${MAX_PIECES} piezas por producto`);
    return quantity;
  }
  const grams = Math.round(quantity * 1000);
  if (Math.abs(quantity * 1000 - grams) > 1e-6) throw new Error("Peso inválido: usa hasta 3 decimales (0.25 kg = 250 g)");
  if (grams < MIN_GRAMS) throw new Error(`Peso inválido: el mínimo es ${MIN_GRAMS} g (${MIN_GRAMS / 1000} kg)`);
  if (grams > MAX_GRAMS) throw new Error(`Peso inválido: el máximo es ${MAX_GRAMS / 1000} kg por producto`);
  return grams;
}

/** Unidades base → cantidad para mostrar (piezas, o kg con decimales). */
export function fromBase(base: number, unit: Unit): number {
  return unit === "kg" ? base / 1000 : base;
}

/** 3 → "3" · 250 g → "250 g" · 1500 g → "1.5 kg" */
export function formatQuantity(base: number, unit: Unit): string {
  if (unit === "pieza") return String(base);
  return base < 1000 ? `${base} g` : `${Number((base / 1000).toFixed(3))} kg`;
}

/** Línea de un pedido: "2 × Americano" · "Arrachera · 750 g" */
export function itemLabel(name: string, base: number, unit: Unit): string {
  return unit === "kg" ? `${name} · ${formatQuantity(base, unit)}` : `${base} × ${name}`;
}

/** "2.43 USDC" · "8.11 USDC / kg" */
export function priceLabel(priceAtomic: number, unit: Unit): string {
  return `${formatUsdc(priceAtomic)} USDC${unit === "kg" ? " / kg" : ""}`;
}

/**
 * Importe de una línea en unidades atómicas.
 * Por kilo se redondea al centavo: así cada línea que dice el agente suma exactamente el total que se cobra.
 */
export function lineTotalAtomic(priceAtomic: number, base: number, unit: Unit): number {
  if (unit === "pieza") return priceAtomic * base;
  return Math.max(CENT, Math.round((priceAtomic * base) / 1000 / CENT) * CENT);
}
