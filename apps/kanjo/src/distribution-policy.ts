import type { DistributionPolicy } from "@zero-two-labs/sekisho";

/**
 * Política de reparto desde el entorno. La decisión vive en el SDK (decideDistribution);
 * aquí solo se leen los valores. Lo que falte usa los valores por defecto del SDK:
 * ≥ 5 USDC, o 24 h con ≥ 0.25 USDC, o una subida de fee a 48 h o menos (también con ≥ 0.25 USDC).
 */
export function policyFromEnv(): Partial<DistributionPolicy> {
  const policy: Partial<DistributionPolicy> = {};
  if (process.env.DISTRIBUTE_MIN_USDC) policy.minUsdc = process.env.DISTRIBUTE_MIN_USDC;
  if (process.env.DISTRIBUTE_MAX_HOURS) policy.maxHours = Number(process.env.DISTRIBUTE_MAX_HOURS);
  if (process.env.DISTRIBUTE_AGE_MIN_USDC) policy.ageMinUsdc = process.env.DISTRIBUTE_AGE_MIN_USDC;
  if (process.env.DISTRIBUTE_FEE_CHANGE_HOURS) {
    policy.feeChangeHours = Number(process.env.DISTRIBUTE_FEE_CHANGE_HOURS);
  }
  return policy;
}
