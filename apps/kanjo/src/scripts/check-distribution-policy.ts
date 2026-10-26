import { parseUnits } from "viem";
import { decide, type DistributionPolicy } from "../distribution-policy.js";

const policy: DistributionPolicy = { minAtomic: parseUnits("5", 6), maxHours: 24, feeChangeHours: 48 };
const usdc = (v: string) => parseUnits(v, 6);

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}

check("Vault vacío → no reparte", decide({ pendingAtomic: 0n, oldestUndistributedHours: 48 }, policy).reason === "empty");
check("Vault vacío con --force → tampoco reparte", decide({ pendingAtomic: 0n, oldestUndistributedHours: null }, policy, true).reason === "empty");
check("0.02 USDC y 1 h → espera", decide({ pendingAtomic: usdc("0.02"), oldestUndistributedHours: 1 }, policy).reason === "waiting");
check("5 USDC → reparte por umbral", decide({ pendingAtomic: usdc("5"), oldestUndistributedHours: 1 }, policy).reason === "threshold");
check("0.02 USDC y 24 h → reparte por antigüedad", decide({ pendingAtomic: usdc("0.02"), oldestUndistributedHours: 24 }, policy).reason === "max_age");
check("0.02 USDC sin registro de pagos → espera", decide({ pendingAtomic: usdc("0.02"), oldestUndistributedHours: null }, policy).reason === "waiting");
check("0.02 USDC con --force → reparte", decide({ pendingAtomic: usdc("0.02"), oldestUndistributedHours: 1 }, policy, true).reason === "forced");


const small = { pendingAtomic: usdc("0.02"), oldestUndistributedHours: 1 };
check(
  "Subida de fee en 24 h → reparte ya (protección)",
  decide({ ...small, feeChange: { hoursLeft: 24, increase: true } }, policy).reason === "fee_change"
);
check(
  "Subida de fee en 5 días → todavía espera",
  decide({ ...small, feeChange: { hoursLeft: 120, increase: true } }, policy).reason === "waiting"
);
check(
  "Bajada de fee en 24 h → espera (conviene repartir con el fee nuevo)",
  decide({ ...small, feeChange: { hoursLeft: 24, increase: false } }, policy).reason === "waiting"
);
check(
  "Vault vacío con subida de fee → no reparte",
  decide({ pendingAtomic: 0n, oldestUndistributedHours: null, feeChange: { hoursLeft: 1, increase: true } }, policy).reason === "empty"
);

console.log(failures === 0 ? "\n✅ Política correcta" : `\n❌ ${failures} prueba(s) fallaron`);
if (failures > 0) process.exitCode = 1;