import { parseUnits } from "viem";
import { DEFAULT_DISTRIBUTION_POLICY, decideDistribution, type VaultState } from "@zero-two-labs/sekisho";

// Kanjō usa la política del SDK; este chequeo fija su comportamiento con los valores por defecto
const policy = DEFAULT_DISTRIBUTION_POLICY;
const usdc = (v: string) => parseUnits(v, 6);
const decide = (state: VaultState, force = false) => decideDistribution(state, policy, force).reason;

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✔" : "✘"} ${label}`);
  if (!condition) failures++;
}

check("Vault vacío → no reparte", decide({ pendingAtomic: 0n, oldestPendingHours: 48 }) === "empty");
check("Vault vacío con --force → tampoco reparte", decide({ pendingAtomic: 0n, oldestPendingHours: null }, true) === "empty");
check("0.02 USDC y 1 h → espera", decide({ pendingAtomic: usdc("0.02"), oldestPendingHours: 1 }) === "waiting");
check("5 USDC → reparte por umbral", decide({ pendingAtomic: usdc("5"), oldestPendingHours: 1 }) === "threshold");
check("0.02 USDC y 24 h → espera (el gas costaría más que la comisión)", decide({ pendingAtomic: usdc("0.02"), oldestPendingHours: 24 }) === "waiting");
check("0.25 USDC y 24 h → reparte por antigüedad", decide({ pendingAtomic: usdc("0.25"), oldestPendingHours: 24 }) === "max_age");
check("0.02 USDC y 7 días → espera (polvo: nunca se reparte solo)", decide({ pendingAtomic: usdc("0.02"), oldestPendingHours: 168 }) === "waiting");
check("0.02 USDC sin registro de pagos → espera", decide({ pendingAtomic: usdc("0.02"), oldestPendingHours: null }) === "waiting");
check("0.02 USDC con --force → reparte", decide({ pendingAtomic: usdc("0.02"), oldestPendingHours: 1 }, true) === "forced");

const half = { pendingAtomic: usdc("0.50"), oldestPendingHours: 1 };
check("Subida de fee en 24 h con 0.50 USDC → reparte ya (protección)", decide({ ...half, feeChange: { hoursLeft: 24, increase: true } }) === "fee_change");
check("Subida de fee en 5 días → todavía espera", decide({ ...half, feeChange: { hoursLeft: 120, increase: true } }) === "waiting");
check("Bajada de fee en 24 h → espera", decide({ ...half, feeChange: { hoursLeft: 24, increase: false } }) === "waiting");
check(
  "Subida de fee en 24 h con 0.02 USDC → espera (debajo del piso)",
  decide({ pendingAtomic: usdc("0.02"), oldestPendingHours: 1, feeChange: { hoursLeft: 24, increase: true } }) === "waiting"
);
check(
  "Vault vacío con subida de fee → no reparte",
  decide({ pendingAtomic: 0n, oldestPendingHours: null, feeChange: { hoursLeft: 1, increase: true } }) === "empty"
);

console.log(failures === 0 ? "\n✅ Política correcta" : `\n❌ ${failures} prueba(s) fallaron`);
if (failures > 0) process.exitCode = 1;
