import { NETWORKS, type SekishoNetwork } from "@zero-two-labs/sekisho";

/**
 * Red de Kanjō: NETWORK=avalancheFuji (por defecto) o NETWORK=avalanche (mainnet, dinero real).
 * env.ts ya validó el valor antes de que se importe este módulo.
 */
export const NETWORK: SekishoNetwork = (process.env.NETWORK || "avalancheFuji") as SekishoNetwork;

export const NETWORK_CONFIG = NETWORKS[NETWORK];

/**
 * RPC propia (recomendada en producción). Vacío = RPCs públicas de la red con respaldo automático.
 * AVALANCHE_FUJI_RPC_URL se sigue aceptando, pero solo en Fuji: nunca se usa una RPC de testnet en mainnet.
 */
export const RPC_URL: string | undefined =
  process.env.AVALANCHE_RPC_URL ||
  (NETWORK === "avalancheFuji" ? process.env.AVALANCHE_FUJI_RPC_URL : undefined) ||
  undefined;
