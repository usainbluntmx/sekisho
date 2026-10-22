import { runDistribution } from "../distributor.js";

// Uso: npm run distribute            → respeta la política
//      npm run distribute -- --force → reparte todo lo pendiente ya
const force = process.argv.includes("--force");
const results = await runDistribution(force);

for (const r of results) {
  console.log(
    `${r.storeId}: ${r.decision.reason} · pendiente ${r.pending} USDC` +
      (r.tx ? ` · tx ${r.tx}` : "") +
      (r.error ? ` · error: ${r.error}` : "")
  );
}