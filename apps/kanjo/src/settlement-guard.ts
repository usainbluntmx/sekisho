/** Pedidos con una liquidación en curso (un solo proceso → basta en memoria). */
const inFlight = new Set<string>();

export function isSettling(orderId: string): boolean {
  return inFlight.has(orderId);
}

/** Devuelve false si ya hay una liquidación en curso para ese pedido. */
export function tryStartSettlement(orderId: string): boolean {
  if (inFlight.has(orderId)) return false;
  inFlight.add(orderId);
  return true;
}

export function endSettlement(orderId: string): void {
  inFlight.delete(orderId);
}