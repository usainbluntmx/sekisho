/**
 * Guarda de red: la RPC configurada debe ser de la red de NETWORK.
 *
 * Si AVALANCHE_RPC_URL apunta a mainnet mientras Kanjō corre en Fuji (o al revés), los pagos se
 * liquidarían en la red equivocada. Al arrancar se compara el chainId que responde la RPC con el
 * esperado: si no coincide, Kanjō no arranca. Si la RPC no responde, solo se avisa (una caída
 * momentánea no debe tumbar el servicio).
 */
export type RpcCheck =
  | { status: "ok"; actual: number }
  | { status: "mismatch"; actual: number }
  | { status: "unreachable"; error: string };

export async function checkRpcChain(readChainId: () => Promise<number>, expected: number, timeoutMs = 10_000): Promise<RpcCheck> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const actual = await Promise.race([
      readChainId(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`sin respuesta en ${timeoutMs / 1000} s`)), timeoutMs);
      }),
    ]);
    return actual === expected ? { status: "ok", actual } : { status: "mismatch", actual };
  } catch (error) {
    return { status: "unreachable", error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

const CHAIN_NAMES: Record<number, string> = { 43113: "Avalanche Fuji", 43114: "Avalanche C-Chain (mainnet)" };

export function chainName(id: number): string {
  return CHAIN_NAMES[id] ?? `chainId ${id}`;
}
