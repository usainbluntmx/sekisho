/**
 * Tope de gas por transacción del SDK. transferWithAuthorization usa ~103k y distribute ~93k;
 * el tope deja margen para despliegues de wallets ERC-6492 y createVault.
 */
export const SETTLEMENT_GAS_CAP = 1_000_000n;

/**
 * Límite de gas: estimación + 20 %, nunca por encima del tope.
 * Protege contra RPCs que devuelven estimaciones absurdas (el nodo rechazaría la tx
 * con "exceeds block gas limit").
 */
export function settlementGasLimit(estimated: bigint, cap: bigint = SETTLEMENT_GAS_CAP): bigint {
  const padded = (estimated * 12n) / 10n;
  return padded > cap ? cap : padded;
}