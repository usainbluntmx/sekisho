/**
 * Reembolsos sin custodia: el comercio devuelve el dinero desde su propia wallet y Kanjō lo verifica.
 *
 * Kanjō nunca toca los fondos. El comercio manda USDC a la wallet que pagó el pedido y luego escribe
 * `/reembolso <pedido> <tx>`. Kanjō lee esa transacción en la cadena y solo la registra si:
 *   - se confirmó con éxito y es posterior al pago del pedido,
 *   - contiene transferencias de USDC desde una wallet de la tienda (la actual o una anterior)
 *     hacia una wallet que pagó ese pedido,
 *   - no se registró antes (una transacción vale para un solo reembolso) y al pedido le falta por reembolsar.
 * Después le avisa al cliente con el comprobante.
 */
import { getAddress, isHash, parseEventLogs, erc20Abi, type Address, type Hash } from "viem";
import { db } from "./db.js";
import { getOrder, getStore } from "./store.js";
import { NETWORK_CONFIG } from "./network.js";
import { enqueueRefund } from "./notify.js";
import { oneLine } from "./errors.js";

export interface ChainTransfer {
  from: Address;
  to: Address;
  value: bigint;
}

/** Lo que se lee de la cadena para una transacción; null si todavía no está confirmada. */
export interface RefundTx {
  success: boolean;
  /** Segundos Unix del bloque. */
  timestamp: number;
  /** Transferencias de USDC (solo del contrato de USDC de la red). */
  transfers: ChainTransfer[];
}

export interface RefundChain {
  readTx(hash: Hash): Promise<RefundTx | null>;
}

let chain: RefundChain = {
  async readTx(hash) {
    const { sekisho } = await import("./payments/usdc-sekisho.js");
    const client = sekisho.publicClient;
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash });
    } catch (error) {
      if ((error as { name?: string }).name === "TransactionReceiptNotFoundError") return null;
      throw error;
    }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const usdc = NETWORK_CONFIG.usdc.toLowerCase();
    const logs = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs.filter((l) => l.address.toLowerCase() === usdc) });
    return {
      success: receipt.status === "success",
      timestamp: Number(block.timestamp),
      transfers: logs.map((l) => ({ from: l.args.from, to: l.args.to, value: l.args.value })),
    };
  },
};

export function setRefundChain(next: RefundChain): void {
  chain = next;
}

export interface RefundInfo {
  orderId: string;
  /** Lo cobrado en la cadena para ese pedido (pago y pagos duplicados). */
  paidAtomic: number;
  refundedAtomic: number;
  remainingAtomic: number;
  /** Wallets que pagaron el pedido: ahí debe llegar el reembolso. */
  payers: Address[];
}

/** Lo cobrado, lo ya reembolsado y a dónde reembolsar. undefined si el pedido no es de esa tienda o no está pagado. */
export function refundInfo(storeId: string, orderId: string): RefundInfo | undefined {
  const found = getOrder(orderId.toUpperCase());
  if (!found || found.order.store_id !== storeId || found.order.status !== "paid") return undefined;
  const id = found.order.id;
  const payments = db.prepare("SELECT payer, amount_atomic AS amount FROM payments WHERE order_id = ?").all(id) as { payer: string | null; amount: number }[];
  const paidAtomic = payments.reduce((sum, p) => sum + Number(p.amount), 0) || found.order.total_atomic;
  const payers = [...new Set(payments.filter((p) => p.payer).map((p) => getAddress(p.payer!)))];
  const refundedAtomic = Number((db.prepare("SELECT COALESCE(SUM(amount_atomic), 0) AS total FROM refunds WHERE order_id = ?").get(id) as { total: number }).total);
  return { orderId: id, paidAtomic, refundedAtomic, remainingAtomic: Math.max(0, paidAtomic - refundedAtomic), payers };
}

/** Pedidos pagados de los últimos 30 días a los que aún les falta por reembolsar (los más recientes primero). */
export function refundableOrders(storeId: string, limit = 10): RefundInfo[] {
  const ids = db
    .prepare("SELECT id FROM orders WHERE store_id = ? AND status = 'paid' AND paid_at > datetime('now', '-30 days') ORDER BY paid_at DESC LIMIT 50")
    .all(storeId) as { id: string }[];
  return ids
    .map((o) => refundInfo(storeId, o.id))
    .filter((r): r is RefundInfo => !!r && r.remainingAtomic > 0)
    .slice(0, limit);
}

/** Wallets de la tienda: la actual y todas las que tuvo antes. */
function storeWallets(storeId: string, current: string): Set<string> {
  const rows = db.prepare("SELECT old_address AS a, new_address AS b FROM wallet_history WHERE store_id = ?").all(storeId) as { a: string; b: string }[];
  return new Set([current, ...rows.flatMap((r) => [r.a, r.b])].map((a) => a.toLowerCase()));
}

/** "2026-11-17 22:24:01" (UTC, formato de SQLite) → segundos Unix. */
function sqliteSeconds(value: string): number {
  return Math.floor(Date.parse(`${value.replace(" ", "T")}Z`) / 1000);
}

export type RefundResult =
  | { ok: true; orderId: string; amountAtomic: number; refundedAtomic: number; complete: boolean; customerNotified: boolean }
  | { ok: false; error: string };

/** Verifica una transacción de reembolso y, si es válida, la registra y avisa al cliente. */
export async function recordRefund(storeId: string, orderId: string, tx: string): Promise<RefundResult> {
  const store = getStore(storeId);
  const info = store ? refundInfo(storeId, orderId) : undefined;
  if (!store || !info) return { ok: false, error: "No encuentro ese pedido pagado en tu tienda. Usa /reembolso para ver tus pedidos." };
  if (!isHash(tx)) return { ok: false, error: "Eso no parece una transacción: debe empezar con 0x y tener 64 caracteres más. Cópiala de tu wallet o del explorador." };
  const hash = tx.toLowerCase() as Hash;
  if (db.prepare("SELECT 1 FROM refunds WHERE tx = ?").get(hash)) return { ok: false, error: "Esa transacción ya está registrada como reembolso." };
  if (info.remainingAtomic === 0) return { ok: false, error: `El pedido ${info.orderId} ya está reembolsado por completo.` };
  if (info.payers.length === 0) return { ok: false, error: `No tengo la wallet que pagó el pedido ${info.orderId}, así que no puedo verificar el reembolso. Escríbenos.` };

  let read: RefundTx | null;
  try {
    read = await chain.readTx(hash);
  } catch (error) {
    console.error(`[refund] No pude leer ${hash}: ${oneLine(error)}`);
    return { ok: false, error: "Ahora no pude leer la red. Inténtalo de nuevo en un rato." };
  }
  if (!read) return { ok: false, error: "Todavía no encuentro esa transacción en la red. Si la acabas de enviar, espera unos segundos y vuelve a intentarlo." };
  if (!read.success) return { ok: false, error: "Esa transacción falló en la red: no movió fondos." };

  const paidAt = getOrder(info.orderId)!.order.paid_at;
  if (paidAt && read.timestamp < sqliteSeconds(paidAt)) return { ok: false, error: "Esa transacción es anterior al pago del pedido; no puede ser su reembolso." };

  const wallets = storeWallets(storeId, store.merchant_address);
  const payers = new Set(info.payers.map((p) => p.toLowerCase()));
  const matching = read.transfers.filter((t) => wallets.has(t.from.toLowerCase()) && payers.has(t.to.toLowerCase()));
  if (matching.length === 0) {
    return {
      ok: false,
      error: `En esa transacción no hay USDC enviado desde la wallet de tu tienda (${short(store.merchant_address)}) a la wallet que pagó (${info.payers.map(short).join(", ")}). El reembolso debe salir de tu wallet, no de un exchange.`,
    };
  }
  const amount = matching.reduce((sum, t) => sum + t.value, 0n);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: "El monto de esa transacción no es válido." };
  const amountAtomic = Number(amount);

  // Se vuelve a revisar justo antes de guardar: entre la lectura de la red y aquí pudo registrarse otro reembolso.
  const fresh = refundInfo(storeId, info.orderId)!;
  if (fresh.remainingAtomic === 0) return { ok: false, error: `El pedido ${info.orderId} ya está reembolsado por completo.` };
  const inserted = db
    .prepare("INSERT OR IGNORE INTO refunds (tx, order_id, store_id, amount_atomic, from_address, to_address) VALUES (?, ?, ?, ?, ?, ?)")
    .run(hash, info.orderId, storeId, amountAtomic, getAddress(matching[0].from), getAddress(matching[0].to));
  if (Number(inserted.changes) === 0) return { ok: false, error: "Esa transacción ya está registrada como reembolso." };

  const refundedAtomic = fresh.refundedAtomic + amountAtomic;
  const complete = refundedAtomic >= fresh.paidAtomic;
  const customerNotified = enqueueRefund(info.orderId, hash, amountAtomic, complete);
  console.log(`[refund] ${storeId} ${info.orderId}: ${amountAtomic} atómico (${hash})`);
  return { ok: true, orderId: info.orderId, amountAtomic, refundedAtomic, complete, customerNotified };
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
