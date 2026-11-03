import type { Address, Hash } from "viem";

export type Net = "avalanche" | "avalancheFuji";

export const NET_LABEL: Record<Net, string> = { avalanche: "mainnet", avalancheFuji: "Fuji" };

/** watch.json: qué se vigila. Solo direcciones públicas. */
export interface Watch {
  networks: Partial<
    Record<
      Net,
      {
        operators: { label: string; address: Address; minAvax: string }[];
        merchants: { label: string; address: Address; splitAtUsdc: string }[];
        admin?: { factory: Address; safe: Address };
      }
    >
  >;
  endpoints: { label: string; url: string }[];
  metricsUrl: string;
  github: string;
  rules: {
    pendingMaxHours: number;
    pendingAgeMinUsdc: string;
    metricsMaxLagBlocks: number;
    adminLookbackBlocks: number;
    remindEveryHours: number;
  };
}

/** Todo lo que se leyó en un chequeo. Lo que no se pudo leer queda en `errors`. */
export interface Facts {
  at: Date;
  balances: { network: Net; label: string; address: Address; wei: bigint; minWei: bigint }[];
  vaults: {
    network: Net;
    label: string;
    merchant: Address;
    vault: Address;
    deployed: boolean;
    pending: bigint; // USDC atómico (6 decimales)
    splitAt: bigint;
    lastPaymentAt: Date | null; // solo mainnet (sale de /v1/metrics)
  }[];
  endpoints: { label: string; url: string; ok: boolean; status?: number; ms?: number; error?: string }[];
  metrics?: {
    syncing: boolean;
    syncedBlock: bigint | null;
    chainHead: bigint | null;
    totalPayments: number;
    x402Payments: number;
    externalPayments: number;
    last24h: { payments: number; external: number; x402: number; capped: boolean };
  };
  admin: { network: Net; contract: "factory" | "safe"; event: string; tx: Hash; block: bigint }[];
  /** Último bloque revisado por red para eventos de administración (se guarda en el estado). */
  adminScannedTo: Partial<Record<Net, bigint>>;
  ci?: { id: number; status: string; conclusion: string | null; title: string; sha: string; url: string };
  errors: { key: string; text: string }[];
}

export interface Alert {
  key: string;
  text: string;
}
