import { getAddress, parseEther, parseUnits, toEventSelector, type Address, type Hash, type PublicClient } from "viem";
import { createSekishoClient } from "@zero-two-labs/sekisho";
import type { Facts, Net, Watch } from "./types.js";

/** Eventos que indican un cambio de administración. Se comparan por topic0 (sirve para Safe 1.3 y 1.4). */
const ADMIN_EVENTS: Record<"factory" | "safe", string[]> = {
  factory: [
    "FeeChangeScheduled(uint16,uint64)",
    "FeeChangeCancelled(uint16)",
    "FeeUpdated(uint16)",
    "TreasuryUpdated(address)",
    "OwnershipTransferred(address,address)",
  ],
  safe: [
    "ExecutionSuccess(bytes32,uint256)",
    "ExecutionFailure(bytes32,uint256)",
    "AddedOwner(address)",
    "RemovedOwner(address)",
    "ChangedThreshold(uint256)",
    "ChangedGuard(address)",
    "EnabledModule(address)",
    "DisabledModule(address)",
    "ChangedFallbackHandler(address)",
  ],
};
const TOPICS = new Map<string, { contract: "factory" | "safe"; event: string }>();
for (const [contract, events] of Object.entries(ADMIN_EVENTS) as ["factory" | "safe", string[]][]) {
  for (const event of events) TOPICS.set(toEventSelector(event), { contract, event: event.split("(")[0] });
}

const RPC_ENV: Record<Net, string> = { avalanche: "AVALANCHE_RPC_URL", avalancheFuji: "FUJI_RPC_URL" };
const MAX_RANGE = 2048n;
const MIN_RANGE = 16n;

interface MetricsJson {
  syncing: boolean;
  syncedBlock: string | null;
  totals: { payments: number; x402Payments?: number };
  external: { payments: number };
  recent: { at: string; external: boolean; kind?: string }[];
  vaults: { vault: string; lastPaymentAt?: string | null }[];
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

async function scanAdmin(client: PublicClient, addresses: Address[], from: bigint, to: bigint) {
  const found: { topic: string; address: Address; tx: Hash; block: bigint }[] = [];
  let range = MAX_RANGE;
  let start = from;
  while (start <= to) {
    const end = start + range - 1n < to ? start + range - 1n : to;
    try {
      const logs = await client.getLogs({ address: addresses, fromBlock: start, toBlock: end });
      for (const log of logs) {
        if (log.topics[0]) found.push({ topic: log.topics[0], address: getAddress(log.address), tx: log.transactionHash!, block: log.blockNumber! });
      }
      start = end + 1n;
      if (range < MAX_RANGE) range *= 2n;
    } catch (error) {
      if (range <= MIN_RANGE) throw error;
      range /= 2n;
    }
  }
  return found;
}

/** Lee todo. Cada lectura es independiente: si una falla, queda en `errors` y las demás siguen. */
export async function collect(
  watch: Watch,
  options: { adminScannedTo: Partial<Record<Net, bigint>>; env?: NodeJS.ProcessEnv; now?: Date }
): Promise<Facts> {
  const env = options.env ?? process.env;
  const facts: Facts = {
    at: options.now ?? new Date(),
    balances: [],
    vaults: [],
    endpoints: [],
    admin: [],
    adminScannedTo: {},
    errors: [],
  };
  const fail = (key: string, text: string, error: unknown) =>
    facts.errors.push({ key, text: `${text}: ${(error as Error).message.split("\n")[0]}` });

  // Métricas de mainnet primero: dan la fecha del último pago de cada vault
  let metrics: MetricsJson | undefined;
  try {
    const res = await fetch(watch.metricsUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    metrics = (await res.json()) as MetricsJson;
  } catch (error) {
    fail("metrics", "las métricas (/v1/metrics)", error);
  }
  const lastPaymentByVault = new Map(
    (metrics?.vaults ?? []).map((v) => [v.vault.toLowerCase(), v.lastPaymentAt ? new Date(v.lastPaymentAt) : null])
  );

  const heads: Partial<Record<Net, bigint>> = {};
  for (const [network, target] of Object.entries(watch.networks) as [Net, NonNullable<Watch["networks"][Net]>][]) {
    const rpcUrl = env[RPC_ENV[network]] || undefined;
    const sekisho = createSekishoClient({ network, rpcUrl });
    const client = sekisho.publicClient;

    try {
      heads[network] = await client.getBlockNumber();
    } catch (error) {
      fail(`rpc:${network}`, `la RPC de ${network}`, error);
      continue; // sin RPC no tiene caso seguir con esta red
    }

    for (const op of target.operators) {
      try {
        const wei = await client.getBalance({ address: op.address });
        facts.balances.push({ network, label: op.label, address: op.address, wei, minWei: parseEther(op.minAvax) });
      } catch (error) {
        fail(`balance:${network}:${op.address}`, `el saldo de ${op.label}`, error);
      }
    }

    for (const m of target.merchants) {
      try {
        const p = await sekisho.pending(m.address);
        facts.vaults.push({
          network,
          label: m.label,
          merchant: m.address,
          vault: p.vault,
          deployed: p.deployed,
          pending: p.total,
          splitAt: parseUnits(m.splitAtUsdc, 6),
          lastPaymentAt: network === "avalanche" ? (lastPaymentByVault.get(p.vault.toLowerCase()) ?? null) : null,
        });
      } catch (error) {
        fail(`vault:${network}:${m.address}`, `el vault de ${m.label}`, error);
      }
    }

    if (target.admin) {
      const head = heads[network]!;
      const previous = options.adminScannedTo[network];
      const lookback = BigInt(watch.rules.adminLookbackBlocks);
      const from = previous !== undefined ? previous + 1n : head > lookback ? head - lookback : 0n;
      try {
        const logs = await scanAdmin(client, [target.admin.factory, target.admin.safe], from, head);
        for (const log of logs) {
          const known = TOPICS.get(log.topic);
          const expected = known?.contract === "safe" ? target.admin.safe : target.admin.factory;
          if (known && getAddress(expected) === log.address) {
            facts.admin.push({ network, contract: known.contract, event: known.event, tx: log.tx, block: log.block });
          }
        }
        facts.adminScannedTo[network] = head;
      } catch (error) {
        fail(`admin:${network}`, `los eventos de la factory y la Safe (${network})`, error);
      }
    }
  }

  if (metrics) {
    const since = facts.at.getTime() - 86_400_000;
    const recent = metrics.recent.filter((p) => new Date(p.at).getTime() >= since);
    facts.metrics = {
      syncing: metrics.syncing,
      syncedBlock: metrics.syncedBlock === null ? null : BigInt(metrics.syncedBlock),
      chainHead: heads.avalanche ?? null,
      totalPayments: metrics.totals.payments,
      x402Payments: metrics.totals.x402Payments ?? 0,
      externalPayments: metrics.external.payments,
      last24h: {
        payments: recent.length,
        external: recent.filter((p) => p.external).length,
        x402: recent.filter((p) => p.kind === "x402").length,
        capped: recent.length === metrics.recent.length && metrics.recent.length >= 20,
      },
    };
  }

  for (const e of watch.endpoints) {
    try {
      const { value: res, ms } = await timed(() =>
        fetch(e.url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "sekisho-ops" } })
      );
      facts.endpoints.push({ label: e.label, url: e.url, ok: res.ok, status: res.status, ms });
    } catch (error) {
      facts.endpoints.push({ label: e.label, url: e.url, ok: false, error: (error as Error).message.split("\n")[0] });
    }
  }

  try {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "sekisho-ops" };
    if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const res = await fetch(
      `https://api.github.com/repos/${watch.github}/actions/runs?branch=main&event=push&per_page=10`,
      { headers, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      workflow_runs: { id: number; name: string; status: string; conclusion: string | null; display_title: string; head_sha: string; html_url: string }[];
    };
    const run = body.workflow_runs.find((r) => r.name === "CI");
    if (run) {
      facts.ci = { id: run.id, status: run.status, conclusion: run.conclusion, title: run.display_title, sha: run.head_sha, url: run.html_url };
    }
  } catch (error) {
    fail("ci", "el estado del CI en GitHub", error);
  }

  return facts;
}
