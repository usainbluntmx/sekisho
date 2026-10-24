import { fallback, http, type Transport } from "viem";
import type { NetworkConfig } from "./chains.js";

/**
 * Transporte con respaldo automático entre RPCs.
 * Orden: las RPCs del usuario (si las da) y después las públicas de la red.
 * Si una RPC falla (403, 429, 5xx, timeout), viem pasa a la siguiente;
 * los errores del contrato (revert) no se reintentan.
 */
export function createSekishoTransport(
  config: NetworkConfig,
  rpcUrl?: string | readonly string[],
): Transport {
  const custom = rpcUrl === undefined ? [] : typeof rpcUrl === "string" ? [rpcUrl] : [...rpcUrl];
  const urls = [...new Set([...custom, ...config.rpcUrls])];

  // retryCount: 0 en cada RPC para que el respaldo pase rápido a la siguiente;
  // el fallback reintenta la lista completa.
  return fallback(
    urls.map((url) => http(url, { retryCount: 0, timeout: 10_000 })),
    { retryCount: 2 },
  );
}