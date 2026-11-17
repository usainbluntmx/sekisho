import { getAddress, type Address } from "viem";
import { createSekishoDistributor, type DistributionDecision } from "@zero-two-labs/sekisho";
import { db } from "./db.js";
import { sekisho } from "./payments/usdc-sekisho.js";
import { policyFromEnv } from "./distribution-policy.js";
import { recentPreviousWallets } from "./wallet-link.js";
import { oneLine } from "./errors.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS distributions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id     TEXT NOT NULL REFERENCES stores(id),
    tx           TEXT NOT NULL,
    total_atomic INTEGER NOT NULL,
    fee_atomic   INTEGER NOT NULL,
    reason       TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_distributions_store ON distributions (store_id, created_at);
`);

export interface DistributionResult {
  storeId: string;
  decision: DistributionDecision;
  pending: string;
  tx?: string;
  error?: string;
}

interface StoreRow {
  id: string;
  merchant_address: string;
}

function listStores(): StoreRow[] {
  return db.prepare("SELECT id, merchant_address FROM stores").all() as unknown as StoreRow[];
}

/**
 * Tiendas y también sus wallets anteriores (30 días tras un cambio): si a un vault viejo llegó
 * algo después del cambio, se reparte igual, a la wallet anterior.
 */
function listVaultOwners(): StoreRow[] {
  const current = listStores();
  const seen = new Set(current.map((s) => getAddress(s.merchant_address)));
  const previous = recentPreviousWallets()
    .filter((w) => !seen.has(getAddress(w.address)))
    .map((w) => ({ id: w.storeId, merchant_address: w.address }));
  return [...current, ...previous];
}

/** Fecha del pago más antiguo de la tienda posterior a su último reparto (null si no hay). */
function oldestUndistributedAt(storeId: string): Date | null {
  const row = db
    .prepare(
      `SELECT MIN(p.created_at) AS oldest
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE o.store_id = ?
         AND p.created_at > COALESCE((SELECT MAX(created_at) FROM distributions WHERE store_id = ?), '')`
    )
    .get(storeId, storeId) as { oldest: string | null };
  // SQLite guarda datetime('now') en UTC con el formato "YYYY-MM-DD HH:MM:SS"
  return row.oldest ? new Date(`${row.oldest.replace(" ", "T")}Z`) : null;
}

/**
 * Si está puesto, la próxima revisión mira solo este vault (tras un pago). El SDK lee la lista
 * de vendedores en cuanto empieza la revisión, así que basta con ponerlo justo antes de llamarla.
 */
let onlyMerchant: Address | null = null;

/** Repartidor del SDK; la antigüedad de los pagos sale de la base, así que sobrevive reinicios. */
const distributor = createSekishoDistributor({
  sekisho,
  merchants: () => merchantsToCheck(),
  policy: policyFromEnv(),
  log: (message) => console.log(message.replace("[sekisho]", "[distributor]")),
  onError: (error, merchant) =>
    console.error(`[distributor] ${merchant ?? "revisión"}: falló, se reintenta en la próxima revisión: ${oneLine(error)}`),
  onDistributed: ({ merchant, tx, total, fee, reason }) => {
    // Un vault por vendedor: el reparto se anota en la primera tienda de ese vendedor
    const store = listVaultOwners().find((s) => getAddress(s.merchant_address) === merchant);
    if (!store) return;
    db.prepare(
      `INSERT INTO distributions (store_id, tx, total_atomic, fee_atomic, reason)
       VALUES (?, ?, ?, ?, ?)`
    ).run(store.id, tx, Number(total), Number(fee), reason);
  },
});

/** Revisa cada tienda y reparte su vault si la política lo indica. */
export async function runDistribution(force = false): Promise<DistributionResult[]> {
  const stores = listStores();
  for (const store of stores) {
    const oldest = oldestUndistributedAt(store.id);
    if (oldest) distributor.notePayment(getAddress(store.merchant_address), oldest);
  }

  const results = await distributor.check({ force });
  return results.map((result) => ({
    storeId:
      stores.find((s) => getAddress(s.merchant_address) === result.merchant)?.id ?? result.merchant,
    decision: result.decision,
    pending: result.pending,
    tx: result.tx,
    error: result.error,
  }));
}

/** Revisión periódica (solo en modo por lotes). */
export function startDistributionScheduler(): void {
  if ((process.env.DISTRIBUTE_MODE ?? "batch") !== "batch") return;

  const minutes = Number(process.env.DISTRIBUTE_CHECK_MINUTES ?? 15);
  const tick = () => {
    void runDistribution().catch((error) => console.error("[distributor] Error inesperado:", error));
  };

  setInterval(tick, minutes * 60_000).unref();
  tick();
  const policy = distributor.policy;
  console.log(
    `[distributor] Reparto por lotes: revisión cada ${minutes} min ` +
      `(≥ ${policy.minUsdc} USDC, o ${policy.maxHours} h con ≥ ${policy.ageMinUsdc} USDC)`
  );
}

/**
 * Revisión inmediata tras un pago (modo por lotes): mira SOLO el vault que cobró (SEKISHO-PERF-003)
 * y reparte ya si alcanzó el umbral. Los demás vaults se quedan para la revisión periódica.
 */
export function checkAfterPayment(merchant: Address): void {
  if ((process.env.DISTRIBUTE_MODE ?? "batch") !== "batch") return;
  const vaultOwner = getAddress(merchant);
  distributor.notePayment(vaultOwner);
  onlyMerchant = vaultOwner;
  const run = distributor.check();
  onlyMerchant = null;
  void run.catch((error) => console.error("[distributor] Error inesperado:", error));
}

/** Para pruebas: qué vendedores revisaría la próxima revisión. */
export function merchantsToCheck(): Address[] {
  return onlyMerchant ? [onlyMerchant] : [...new Set(listVaultOwners().map((store) => getAddress(store.merchant_address)))];
}
