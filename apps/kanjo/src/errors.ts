/**
 * Error en una línea: viem trae el detalle completo (URL, body, docs…) en `message`; para el log
 * basta el resumen (`shortMessage`) más la causa, si la hay (p. ej. "The request timed out.").
 */
export function oneLine(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const e = error as Error & { shortMessage?: string; details?: string };
  const head = e.shortMessage ?? e.message.split("\n")[0];
  return e.details && e.details !== head ? `${head} (${e.details})` : head;
}
