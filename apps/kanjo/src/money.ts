/** USDC usa 6 decimales: 1 USDC = 1_000_000 unidades atómicas. */
export const USDC_DECIMALS = 6;
const UNIT = 10 ** USDC_DECIMALS;

/** "2.50" → 2500000 */
export function usdc(amount: string): number {
  const value = Math.round(Number(amount) * UNIT);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Monto inválido: ${amount}`);
  }
  return value;
}

/** 2500000 → "2.50" */
export function formatUsdc(atomic: number): string {
  return (atomic / UNIT).toFixed(2);
}