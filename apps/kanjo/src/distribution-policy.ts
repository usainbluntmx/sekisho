import { parseUnits } from "viem";

export interface DistributionPolicy {
  /** Reparte en cuanto el saldo pendiente alcanza este monto (atómico, 6 decimales). */
  minAtomic: bigint;
  /** Reparte aunque no se alcance el mínimo si el pago más antiguo tiene estas horas. */
  maxHours: number;
}

export interface VaultState {
  pendingAtomic: bigint;
  /** Horas del pago más antiguo sin repartir, o null si no hay registro. */
  oldestUndistributedHours: number | null;
}

export type Decision =
  | { distribute: true; reason: "threshold" | "max_age" | "forced" }
  | { distribute: false; reason: "empty" | "waiting" };

export function decide(state: VaultState, policy: DistributionPolicy, force = false): Decision {
  if (state.pendingAtomic === 0n) return { distribute: false, reason: "empty" };
  if (force) return { distribute: true, reason: "forced" };
  if (state.pendingAtomic >= policy.minAtomic) return { distribute: true, reason: "threshold" };
  if (state.oldestUndistributedHours !== null && state.oldestUndistributedHours >= policy.maxHours) {
    return { distribute: true, reason: "max_age" };
  }
  return { distribute: false, reason: "waiting" };
}

export function policyFromEnv(): DistributionPolicy {
  return {
    minAtomic: parseUnits(process.env.DISTRIBUTE_MIN_USDC ?? "5", 6),
    maxHours: Number(process.env.DISTRIBUTE_MAX_HOURS ?? 24),
  };
}