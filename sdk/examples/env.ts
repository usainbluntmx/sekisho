import { getAddress, type Address, type Hex } from "viem";
import { NETWORKS, type DistributionPolicy, type SekishoNetwork } from "../src/index.js";

/** Red de los ejemplos: SEKISHO_NETWORK=avalanche para mainnet (por defecto, Fuji). */
export const network: SekishoNetwork = (() => {
  const value = process.env.SEKISHO_NETWORK || "avalancheFuji";
  if (!(value in NETWORKS)) {
    throw new Error(`SEKISHO_NETWORK inválida: "${value}" (usa ${Object.keys(NETWORKS).join(" o ")})`);
  }
  return value as SekishoNetwork;
})();

/** Vendedor de los ejemplos (por defecto, el de demo). */
export const MERCHANT: Address = getAddress(
  process.env.MERCHANT_ADDRESS || "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae"
);

/** Llave privada obligatoria desde sdk/.env. */
export function requireKey(name: string): Hex {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name} en sdk/.env`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} debe ser 0x + 64 caracteres hex`);
  return value as Hex;
}

/** Política de reparto desde variables DISTRIBUTE_* (las que falten usan los valores por defecto del SDK). */
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
