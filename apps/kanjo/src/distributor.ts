import { formatUnits, type Address } from "viem";
import { db } from "./db.js";
import { sekisho } from "./payments/usdc-sekisho.js";
import { decide, policyFromEnv, type Decision } from "./distribution-policy.js";

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
  decision: Decision;
  pending: string;
  tx?: string;
  error?: string;
}

/** Horas del pago más antiguo de la tienda posterior al último reparto. */
function oldestUndistributedHours(storeId: string): number | null {
  const row = db
    .prepare(
      `SELECT (julianday('now') - julianday(MIN(p.created_at))) * 24 AS hours
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE o.store_id = ?
         AND p.created_at > COALESCE((SELECT MAX(created_at) FROM distributions WHERE store_id = ?), '')`
    )
    .get(storeId, storeId) as { hours: number | null };
  return row.hours ?? null;
}

let running = false;

/** Revisa cada tienda y reparte su vault si la política lo indica. */
export async function runDistribution(force = false): Promise<DistributionResult[]> {
  if (running) return [];
  running = true;

  try {
    const policy = policyFromEnv();
    const stores = db.prepare("SELECT id, merchant_address FROM stores").all() as unknown as {
      id: string;
      merchant_address: string;
    }[];

    const results: DistributionResult[] = [];

    for (const store of stores) {
      const merchant = store.merchant_address as Address;
      try {
        const pending = await sekisho.pending(merchant);
        const decision = decide(
          { pendingAtomic: pending.total, oldestUndistributedHours: oldestUndistributedHours(store.id) },
          policy,
          force
        );
        const result: DistributionResult = {
          storeId: store.id,
          decision,
          pending: formatUnits(pending.total, 6),
        };

        if (decision.distribute) {
          const tx = await sekisho.distribute(merchant);
          db.prepare(
            `INSERT INTO distributions (store_id, tx, total_atomic, fee_atomic, reason)
             VALUES (?, ?, ?, ?, ?)`
          ).run(store.id, tx, Number(pending.total), Number(pending.fee), decision.reason);
          console.log(
            `[distributor] ${store.id}: reparto de ${result.pending} USDC (${decision.reason}) → ${sekisho.config.explorer}/tx/${tx}`
          );
          result.tx = tx;
        } else if (decision.reason === "waiting") {
          console.log(
            `[distributor] ${store.id}: ${result.pending} USDC pendientes, esperando (mínimo ${formatUnits(policy.minAtomic, 6)} USDC o ${policy.maxHours} h)`
          );
        }

        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[distributor] ${store.id}: falló, se reintenta en la próxima revisión: ${message}`);
        results.push({ storeId: store.id, decision: { distribute: false, reason: "waiting" }, pending: "?", error: message });
      }
    }

    return results;
  } finally {
    running = false;
  }
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
  console.log(`[distributor] Reparto por lotes: revisión cada ${minutes} min`);
}