import { getAddress, type Address } from "viem";
import { createSekishoDistributor, type DistributionDecision } from "@zero-two-labs/sekisho";
import { db } from "./db.js";
import { sekisho } from "./payments/usdc-sekisho.js";
import { policyFromEnv } from "./distribution-policy.js";

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

/** Repartidor del SDK; la antigüedad de los pagos sale de la base, así que sobrevive reinicios. */
const distributor = createSekishoDistributor({
  sekisho,
  merchants: () => listStores().map((store) => getAddress(store.merchant_address)),
  policy: policyFromEnv(),
  log: (message) => console.log(message.replace("[sekisho]", "[distributor]")),
  onError: (error, merchant) =>
    console.error(
      `[distributor] ${merchant ?? "revisión"}: falló, se reintenta en la próxima revisión:`,
      error instanceof Error ? error.message : error
    ),
  onDistributed: ({ merchant, tx, total, fee, reason }) => {
    // Un vault por vendedor: el reparto se anota en la primera tienda de ese vendedor
    const store = listStores().find((s) => getAddress(s.merchant_address) === merchant);
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

/** Revisión inmediata tras un pago (modo por lotes): reparte ya si se alcanzó el umbral. */
export function checkAfterPayment(merchant: Address): void {
  if ((process.env.DISTRIBUTE_MODE ?? "batch") !== "batch") return;
  distributor.notePayment(getAddress(merchant));
  void runDistribution().catch((error) => console.error("[distributor] Error inesperado:", error));
}
