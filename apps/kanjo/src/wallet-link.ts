/**
 * Prueba de propiedad de la wallet del comerciante (SEKISHO-ARCH-010).
 *
 * En lugar de copiar la dirección y confirmar sus últimos 4 caracteres, el comerciante abre un
 * link de un solo uso en el navegador de su wallet y firma un mensaje (EIP-191, personal_sign).
 * La dirección que se guarda es la que firmó: una dirección de exchange no puede firmar, así que
 * queda fuera sola. Firmar no es una transacción y no cuesta gas.
 *
 * El mismo mecanismo sirve para cambiar la wallet de una tienda. El cambio reparte primero lo
 * pendiente del vault anterior (a la wallet anterior) y luego apunta la tienda a la nueva.
 */
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { db } from "./db.js";
import { getStore, type Store } from "./store.js";
import { isSettling } from "./settlement-guard.js";
import { oneLine } from "./errors.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_links (
    token        TEXT PRIMARY KEY,
    owner        TEXT NOT NULL,
    store_id     TEXT,
    store_name   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'verified', 'applied', 'rejected')),
    address      TEXT,
    signature    TEXT,
    verified_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS wallet_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id     TEXT NOT NULL,
    old_address  TEXT NOT NULL,
    new_address  TEXT NOT NULL,
    split_tx     TEXT,
    changed_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const hasColumn = (table: string, column: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).some((c) => c.name === column);
if (!hasColumn("stores", "wallet_verified_at")) db.exec("ALTER TABLE stores ADD COLUMN wallet_verified_at TEXT");

export const WALLET_LINK_MINUTES = 30;

export interface WalletLink {
  token: string;
  owner: string;
  /** null = alta de una tienda nueva; con id = cambio de wallet de esa tienda. */
  store_id: string | null;
  store_name: string;
  created_at: string;
  expires_at: string;
  status: "open" | "verified" | "applied" | "rejected";
  address: string | null;
  signature: string | null;
  verified_at: string | null;
}

/** Link nuevo de un solo uso. Los links abiertos anteriores del mismo dueño y propósito dejan de servir. */
export function createWalletLink(owner: string, storeName: string, storeId: string | null = null): WalletLink {
  db.prepare("DELETE FROM wallet_links WHERE owner = ? AND status = 'open' AND store_id IS ?").run(owner, storeId);
  const token = randomBytes(16).toString("base64url");
  db.prepare(
    `INSERT INTO wallet_links (token, owner, store_id, store_name, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', ?))`
  ).run(token, owner, storeId, storeName.slice(0, 80), `+${WALLET_LINK_MINUTES} minutes`);
  return getWalletLink(token)!;
}

export function getWalletLink(token: string): WalletLink | undefined {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return undefined;
  return db.prepare("SELECT * FROM wallet_links WHERE token = ?").get(token) as unknown as WalletLink | undefined;
}

/** Cambio de wallet ya firmado que espera la aprobación del administrador (tienda publicada). */
export function pendingWalletChange(storeId: string): WalletLink | undefined {
  return db
    .prepare("SELECT * FROM wallet_links WHERE store_id = ? AND status = 'verified' ORDER BY verified_at DESC LIMIT 1")
    .get(storeId) as unknown as WalletLink | undefined;
}

export function isLinkExpired(link: WalletLink, now = new Date()): boolean {
  return new Date(`${link.expires_at.replace(" ", "T")}Z`).getTime() <= now.getTime();
}

export function walletLinkUrl(link: WalletLink): string {
  const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/wallet/${link.token}`;
}

/** Mensaje exacto que se firma: liga la wallet a esta tienda, a este dueño y a este link. */
export function walletMessage(link: WalletLink): string {
  const purpose = link.store_id
    ? `Kanjō: cambiar a esta wallet los cobros de la tienda «${link.store_name}» (${link.store_id}).`
    : `Kanjō: esta wallet recibirá los cobros de la tienda «${link.store_name}».`;
  return `${purpose}\n\nDueño: ${link.owner}\nCódigo: ${link.token}\n\nFirmar no mueve fondos ni cuesta gas.`;
}

/**
 * Verifica la firma. Primero localmente (wallets normales, EOA); si no coincide, pregunta a la red
 * (wallets de contrato como Safe, ERC-1271). En pruebas se reemplaza para no tocar la RPC.
 */
export type ContractSignatureCheck = (address: Address, message: string, signature: Hex) => Promise<boolean>;

let contractCheck: ContractSignatureCheck = async (address, message, signature) => {
  const { sekisho } = await import("./payments/usdc-sekisho.js");
  return sekisho.publicClient.verifyMessage({ address, message, signature });
};

export function setContractSignatureCheck(fn: ContractSignatureCheck): void {
  contractCheck = fn;
}

export type VerifyResult = { ok: true; link: WalletLink } | { ok: false; status: 400 | 404 | 409 | 410; error: string };

/** Valida la firma y marca el link como firmado (una sola vez). No cambia ninguna tienda. */
export async function verifyWalletLink(token: string, address: string, signature: string): Promise<VerifyResult> {
  const link = getWalletLink(token);
  if (!link) return { ok: false, status: 404, error: "Este link no existe. Pide uno nuevo en el chat." };
  if (link.status !== "open") return { ok: false, status: 409, error: "Este link ya se usó. Si necesitas otro, pídelo en el chat." };
  if (isLinkExpired(link)) return { ok: false, status: 410, error: `Este link venció (dura ${WALLET_LINK_MINUTES} min). Pide uno nuevo en el chat con /wallet.` };
  if (!isAddress(address, { strict: false }) || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { ok: false, status: 400, error: "Firma o dirección inválida." };
  }

  const wallet = getAddress(address);
  const message = walletMessage(link);
  let valid = false;
  try {
    valid = getAddress(await recoverMessageAddress({ message, signature: signature as Hex })) === wallet;
  } catch {
    valid = false;
  }
  if (!valid) {
    try {
      valid = await contractCheck(wallet, message, signature as Hex);
    } catch {
      valid = false;
    }
  }
  if (!valid) return { ok: false, status: 400, error: "La firma no corresponde a esa wallet. Vuelve a intentarlo desde la wallet que recibirá los cobros." };

  if (link.store_id && !getStore(link.store_id)) return { ok: false, status: 404, error: "La tienda ya no existe." };

  // Solo un ganador si llegan dos firmas a la vez
  const changed = db
    .prepare("UPDATE wallet_links SET status = 'verified', address = ?, signature = ?, verified_at = datetime('now') WHERE token = ? AND status = 'open'")
    .run(wallet, signature, token).changes;
  if (Number(changed) === 0) return { ok: false, status: 409, error: "Este link ya se usó." };
  return { ok: true, link: getWalletLink(token)! };
}

export function markWalletLink(token: string, status: "applied" | "rejected"): void {
  db.prepare("UPDATE wallet_links SET status = ? WHERE token = ?").run(status, token);
}

export function setWalletVerified(storeId: string): void {
  db.prepare("UPDATE stores SET wallet_verified_at = datetime('now') WHERE id = ?").run(storeId);
}

export function walletVerifiedAt(storeId: string): string | null {
  const row = db.prepare("SELECT wallet_verified_at AS at FROM stores WHERE id = ?").get(storeId) as { at: string | null } | undefined;
  return row?.at ?? null;
}

/** Operaciones en la cadena que necesita el cambio; en pruebas se reemplazan. */
export interface WalletChain {
  pendingAtomic(merchant: Address): Promise<bigint>;
  distribute(merchant: Address): Promise<string>;
}

let chain: WalletChain = {
  async pendingAtomic(merchant) {
    const { sekisho } = await import("./payments/usdc-sekisho.js");
    return (await sekisho.pending(merchant)).total;
  },
  async distribute(merchant) {
    const { sekisho } = await import("./payments/usdc-sekisho.js");
    return sekisho.distribute(merchant);
  },
};

export function setWalletChain(next: WalletChain): void {
  chain = next;
}

/** Lo que el vault de ese vendedor tiene pendiente de repartir (USDC atómico). */
export async function vaultPendingAtomic(merchant: string): Promise<bigint> {
  return chain.pendingAtomic(getAddress(merchant));
}

/** Pedidos de la tienda con un cobro en este momento: durante un cobro no se cambia la wallet ni se da de baja. */
export function settlingFor(storeId: string): boolean {
  const ids = db.prepare("SELECT id FROM orders WHERE store_id = ? AND status = 'pending_payment'").all(storeId) as { id: string }[];
  return ids.some((o) => isSettling(o.id));
}

export type ApplyResult = { ok: true; store: Store; oldAddress: string; splitTx?: string } | { ok: false; error: string };

/**
 * Aplica un cambio de wallet ya firmado:
 * 1. Si hay un cobro en curso, no hace nada (se reintenta después).
 * 2. Reparte lo pendiente del vault anterior a la wallet anterior. Si falla, no cambia nada.
 * 3. Apunta la tienda a la wallet nueva (su propio vault) y deja el registro en wallet_history.
 *
 * Un pago firmado hacia el vault viejo justo antes del cambio se rechaza al verificar (el servidor
 * ya cotiza con el vault nuevo), así que ningún cobro termina en el vault anterior.
 */
export async function applyWalletChange(token: string): Promise<ApplyResult> {
  const link = getWalletLink(token);
  if (!link || link.status !== "verified" || !link.store_id || !link.address) return { ok: false, error: "No hay un cambio de wallet firmado con ese link." };
  const store = getStore(link.store_id);
  if (!store) return { ok: false, error: "La tienda ya no existe." };
  if (settlingFor(store.id)) return { ok: false, error: "Hay un pago en curso en esta tienda. Intenta de nuevo en un minuto." };

  const oldAddress = getAddress(store.merchant_address);
  let splitTx: string | undefined;
  try {
    if ((await chain.pendingAtomic(oldAddress)) > 0n) splitTx = await chain.distribute(oldAddress);
  } catch (error) {
    console.error(`[wallet] No se pudo repartir el vault anterior de ${store.id}: ${oneLine(error)}`);
    return { ok: false, error: "No pude repartir lo pendiente del vault anterior; no cambié nada. Intenta más tarde." };
  }

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE stores SET merchant_address = ?, wallet_verified_at = datetime('now') WHERE id = ?").run(getAddress(link.address), store.id);
    db.prepare("INSERT INTO wallet_history (store_id, old_address, new_address, split_tx) VALUES (?, ?, ?, ?)").run(
      store.id,
      oldAddress,
      getAddress(link.address),
      splitTx ?? null
    );
    db.prepare("UPDATE wallet_links SET status = 'applied' WHERE token = ?").run(token);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(`[wallet] ${store.id}: ${oldAddress} → ${getAddress(link.address)}${splitTx ? ` (reparto previo ${splitTx})` : ""}`);
  return { ok: true, store: getStore(store.id)!, oldAddress, splitTx };
}

/**
 * Wallets anteriores de los últimos `days` días: el repartidor las sigue revisando por si llegó
 * algo a un vault viejo, para que nada quede sin repartir.
 */
export function recentPreviousWallets(days = 30): { storeId: string; address: string }[] {
  return (
    db
      .prepare("SELECT store_id AS storeId, old_address AS address FROM wallet_history WHERE changed_at > datetime('now', ?)")
      .all(`-${days} days`) as { storeId: string; address: string }[]
  );
}
