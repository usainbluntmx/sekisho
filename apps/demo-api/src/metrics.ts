import { formatUnits, getAddress, parseAbiItem, type Address, type Hash, type PublicClient } from "viem";
import type { SekishoNetwork } from "@zero-two-labs/sekisho";

/**
 * Métricas públicas de Sekisho leídas directo de la cadena (sin base de datos):
 *   - vaults:   eventos VaultCreated de la factory
 *   - pagos:    transfers de USDC hacia cualquier vault
 *   - repartos: eventos Distributed de los vaults
 * Todo se recalcula desde el bloque de despliegue de la factory al arrancar y luego se
 * actualiza de forma incremental. Un vault cuenta desde que se despliega; en ese momento
 * se recuperan también los pagos que recibió antes de existir (su dirección es predecible).
 */

/** Bloque de despliegue de SplitVaultFactory v3 (backend/deployments/<red>/SplitVaultFactory.json). */
export const FACTORY_DEPLOY_BLOCK: Record<SekishoNetwork, bigint> = {
  avalanche: 98_646_448n,
  avalancheFuji: 60_063_109n,
};

export interface VaultCreatedLog {
  vault: Address;
  merchant: Address;
  block: bigint;
  tx: Hash;
}
export interface TransferLog {
  from: Address;
  to: Address;
  value: bigint;
  block: bigint;
  tx: Hash;
  logIndex: number;
}
export interface DistributedLog {
  vault: Address;
  total: bigint;
  fee: bigint;
  merchantAmount: bigint;
  block: bigint;
  tx: Hash;
  logIndex: number;
}

/** Lo único que el indexador necesita de la cadena. Los tests lo simulan. */
export interface MetricsSource {
  blockNumber(): Promise<bigint>;
  /** Timestamp del bloque en segundos. */
  blockTime(block: bigint): Promise<number>;
  vaultsCreated(fromBlock: bigint, toBlock: bigint): Promise<VaultCreatedLog[]>;
  transfersTo(vaults: Address[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]>;
  distributions(vaults: Address[], fromBlock: bigint, toBlock: bigint): Promise<DistributedLog[]>;
}

const vaultCreatedEvent = parseAbiItem("event VaultCreated(address indexed merchant, address indexed vault)");
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const distributedEvent = parseAbiItem(
  "event Distributed(address indexed token, uint256 total, uint256 fee, uint256 merchantAmount)"
);

/** Fuente real: eth_getLogs vía viem. */
export function viemMetricsSource(client: PublicClient, addresses: { factory: Address; usdc: Address }): MetricsSource {
  const { factory, usdc } = addresses;
  return {
    blockNumber: () => client.getBlockNumber(),
    blockTime: async (blockNumber) => Number((await client.getBlock({ blockNumber })).timestamp),
    async vaultsCreated(fromBlock, toBlock) {
      const logs = await client.getLogs({ address: factory, event: vaultCreatedEvent, fromBlock, toBlock, strict: true });
      return logs.map((log) => ({
        vault: getAddress(log.args.vault),
        merchant: getAddress(log.args.merchant),
        block: log.blockNumber,
        tx: log.transactionHash,
      }));
    },
    async transfersTo(vaults, fromBlock, toBlock) {
      const logs = await client.getLogs({
        address: usdc,
        event: transferEvent,
        args: { to: vaults },
        fromBlock,
        toBlock,
        strict: true,
      });
      return logs.map((log) => ({
        from: getAddress(log.args.from),
        to: getAddress(log.args.to),
        value: log.args.value,
        block: log.blockNumber,
        tx: log.transactionHash,
        logIndex: log.logIndex,
      }));
    },
    async distributions(vaults, fromBlock, toBlock) {
      const logs = await client.getLogs({
        address: vaults,
        event: distributedEvent,
        args: { token: usdc },
        fromBlock,
        toBlock,
        strict: true,
      });
      return logs.map((log) => ({
        vault: getAddress(log.address),
        total: log.args.total,
        fee: log.args.fee,
        merchantAmount: log.args.merchantAmount,
        block: log.blockNumber,
        tx: log.transactionHash,
        logIndex: log.logIndex,
      }));
    },
  };
}

export interface MetricsOptions {
  source: MetricsSource;
  network: SekishoNetwork;
  chainId: number;
  factory: Address;
  usdc: Address;
  /** Desde dónde leer; por defecto, el bloque de despliegue de la factory. */
  fromBlock?: bigint;
  /** Wallets del proyecto (pruebas, merchant de la demo): sus pagos no cuentan como externos. */
  ownWallets?: Address[];
  /** Cada cuánto buscar bloques nuevos (por defecto 60 s). */
  syncSeconds?: number;
  /** Bloques por consulta de logs (por defecto 2048, el máximo de la RPC pública de Avalanche). */
  maxRange?: number;
  log?: (message: string) => void;
}

interface Payment {
  tx: Hash;
  vault: Address;
  payer: Address;
  value: bigint;
  block: bigint;
  at: number;
}
interface Distribution {
  tx: Hash;
  vault: Address;
  total: bigint;
  fee: bigint;
  merchantAmount: bigint;
  block: bigint;
  at: number;
}

export interface MetricsSnapshot {
  network: SekishoNetwork;
  chainId: number;
  factory: Address;
  usdc: Address;
  fromBlock: string;
  syncedBlock: string | null;
  headBlock: string | null;
  /** true hasta terminar la primera lectura completa: las cifras aún son parciales. */
  syncing: boolean;
  updatedAt: string | null;
  ownWallets: Address[];
  totals: {
    payments: number;
    volumeUsdc: string;
    payers: number;
    vaults: number;
    distributions: number;
    distributedUsdc: string;
    toMerchantsUsdc: string;
    feesUsdc: string;
    pendingUsdc: string;
  };
  external: { payments: number; volumeUsdc: string; payers: number };
  daily: { date: string; payments: number; externalPayments: number; volumeUsdc: string }[];
  recent: { tx: Hash; at: string; vault: Address; payer: Address; amountUsdc: string; external: boolean }[];
  vaults: {
    vault: Address;
    merchant: Address;
    createdBlock: string;
    payments: number;
    volumeUsdc: string;
    pendingUsdc: string;
  }[];
}

export interface MetricsIndexer {
  /** Lee hasta el bloque actual. Llamadas simultáneas comparten la misma ejecución. */
  sync(): Promise<void>;
  snapshot(): MetricsSnapshot;
  start(): void;
  stop(): void;
}

const MIN_RANGE = 16n;
const VAULT_BATCH = 100; // direcciones por consulta de logs
const DAYS = 30;

const usdc = (atomic: bigint) => formatUnits(atomic, 6);

export function createMetricsIndexer(options: MetricsOptions): MetricsIndexer {
  const { source } = options;
  const log = options.log ?? ((message: string) => console.log(message));
  const fromBlock = options.fromBlock ?? FACTORY_DEPLOY_BLOCK[options.network];
  const maxRange = BigInt(options.maxRange ?? 2048);
  const own = new Set((options.ownWallets ?? []).map((a) => a.toLowerCase()));

  const vaults = new Map<Address, { merchant: Address; block: bigint }>();
  const payments = new Map<string, Payment>(); // clave: tx:logIndex
  const distributions = new Map<string, Distribution>();
  let syncedBlock: bigint | undefined;
  let headBlock: bigint | undefined;
  let updatedAt: Date | undefined;
  let range = maxRange;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const blockTimes = new Map<bigint, number>();

  async function timeOf(block: bigint): Promise<number> {
    let at = blockTimes.get(block);
    if (at === undefined) {
      at = await source.blockTime(block);
      blockTimes.set(block, at);
    }
    return at;
  }

  /** Recorre [from, to] en tramos; si la RPC rechaza un tramo, lo parte a la mitad y reintenta. */
  async function eachRange(from: bigint, to: bigint, fn: (a: bigint, b: bigint) => Promise<void>): Promise<void> {
    let start = from;
    while (start <= to) {
      const end = start + range - 1n < to ? start + range - 1n : to;
      try {
        await fn(start, end);
      } catch (error) {
        if (range <= MIN_RANGE) throw error;
        range = range / 2n < MIN_RANGE ? MIN_RANGE : range / 2n;
        continue;
      }
      start = end + 1n;
      if (range < maxRange) range = range * 2n > maxRange ? maxRange : range * 2n;
    }
  }

  async function inBatches<T>(list: Address[], fn: (batch: Address[]) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < list.length; i += VAULT_BATCH) out.push(...(await fn(list.slice(i, i + VAULT_BATCH))));
    return out;
  }

  async function addTransfers(list: TransferLog[]): Promise<void> {
    for (const t of list) {
      const key = `${t.tx}:${t.logIndex}`;
      if (payments.has(key)) continue;
      payments.set(key, { tx: t.tx, vault: t.to, payer: t.from, value: t.value, block: t.block, at: await timeOf(t.block) });
    }
  }

  async function processRange(a: bigint, b: bigint): Promise<void> {
    const created = (await source.vaultsCreated(a, b)).filter((v) => !vaults.has(v.vault));

    // Pagos que llegaron al vault antes de desplegarse (la dirección se conoce de antemano).
    // El vault se registra solo después: si esto falla, el tramo se repite completo.
    if (created.length > 0 && a > fromBlock) {
      const fresh = created.map((v) => v.vault);
      await eachRange(fromBlock, a - 1n, async (x, y) =>
        addTransfers(await inBatches(fresh, (batch) => source.transfersTo(batch, x, y)))
      );
    }
    for (const v of created) vaults.set(v.vault, { merchant: v.merchant, block: v.block });

    const all = [...vaults.keys()];
    if (all.length === 0) return;
    const [transfers, dists] = await Promise.all([
      inBatches(all, (batch) => source.transfersTo(batch, a, b)),
      inBatches(all, (batch) => source.distributions(batch, a, b)),
    ]);
    await addTransfers(transfers);
    for (const d of dists) {
      const key = `${d.tx}:${d.logIndex}`;
      if (distributions.has(key)) continue;
      distributions.set(key, {
        tx: d.tx,
        vault: d.vault,
        total: d.total,
        fee: d.fee,
        merchantAmount: d.merchantAmount,
        block: d.block,
        at: await timeOf(d.block),
      });
    }
  }

  async function runSync(): Promise<void> {
    const head = await source.blockNumber();
    headBlock = head;
    const start = syncedBlock === undefined ? fromBlock : syncedBlock + 1n;
    if (start <= head) {
      await eachRange(start, head, async (a, b) => {
        await processRange(a, b);
        syncedBlock = b;
      });
    }
    syncedBlock = head;
    updatedAt = new Date();
    blockTimes.clear();
  }

  function sync(): Promise<void> {
    running ??= runSync().finally(() => {
      running = undefined;
    });
    return running;
  }

  function snapshot(): MetricsSnapshot {
    const isOwn = (address: Address) => own.has(address.toLowerCase());
    const list = [...payments.values()].sort((x, y) => (x.block === y.block ? 0 : x.block < y.block ? 1 : -1));
    const dists = [...distributions.values()];
    const sum = (values: bigint[]) => values.reduce((acc, v) => acc + v, 0n);

    const external = list.filter((p) => !isOwn(p.payer));
    const received = new Map<Address, { count: number; value: bigint }>();
    for (const p of list) {
      const entry = received.get(p.vault) ?? { count: 0, value: 0n };
      entry.count += 1;
      entry.value += p.value;
      received.set(p.vault, entry);
    }
    const paidOut = new Map<Address, bigint>();
    for (const d of dists) paidOut.set(d.vault, (paidOut.get(d.vault) ?? 0n) + d.total);
    const pendingOf = (vault: Address) => {
      const pending = (received.get(vault)?.value ?? 0n) - (paidOut.get(vault) ?? 0n);
      return pending > 0n ? pending : 0n;
    };

    // Últimos 30 días (UTC), incluidos los días sin pagos
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const daily = Array.from({ length: DAYS }, (_, i) => {
      const day = new Date(today.getTime() - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10);
      return { date: day, payments: 0, externalPayments: 0, volume: 0n };
    });
    const byDate = new Map(daily.map((d) => [d.date, d]));
    for (const p of list) {
      const entry = byDate.get(new Date(p.at * 1000).toISOString().slice(0, 10));
      if (!entry) continue;
      entry.payments += 1;
      entry.volume += p.value;
      if (!isOwn(p.payer)) entry.externalPayments += 1;
    }

    return {
      network: options.network,
      chainId: options.chainId,
      factory: options.factory,
      usdc: options.usdc,
      fromBlock: fromBlock.toString(),
      syncedBlock: syncedBlock?.toString() ?? null,
      headBlock: headBlock?.toString() ?? null,
      syncing: updatedAt === undefined,
      updatedAt: updatedAt?.toISOString() ?? null,
      ownWallets: (options.ownWallets ?? []).map((a) => getAddress(a)),
      totals: {
        payments: list.length,
        volumeUsdc: usdc(sum(list.map((p) => p.value))),
        payers: new Set(list.map((p) => p.payer)).size,
        vaults: vaults.size,
        distributions: dists.length,
        distributedUsdc: usdc(sum(dists.map((d) => d.total))),
        toMerchantsUsdc: usdc(sum(dists.map((d) => d.merchantAmount))),
        feesUsdc: usdc(sum(dists.map((d) => d.fee))),
        pendingUsdc: usdc(sum([...vaults.keys()].map(pendingOf))),
      },
      external: {
        payments: external.length,
        volumeUsdc: usdc(sum(external.map((p) => p.value))),
        payers: new Set(external.map((p) => p.payer)).size,
      },
      daily: daily.map(({ volume, ...d }) => ({ ...d, volumeUsdc: usdc(volume) })),
      recent: list.slice(0, 20).map((p) => ({
        tx: p.tx,
        at: new Date(p.at * 1000).toISOString(),
        vault: p.vault,
        payer: p.payer,
        amountUsdc: usdc(p.value),
        external: !isOwn(p.payer),
      })),
      vaults: [...vaults.entries()]
        .map(([vault, v]) => ({
          vault,
          merchant: v.merchant,
          createdBlock: v.block.toString(),
          payments: received.get(vault)?.count ?? 0,
          volume: received.get(vault)?.value ?? 0n,
          pendingUsdc: usdc(pendingOf(vault)),
        }))
        .sort((x, y) => (x.volume === y.volume ? 0 : x.volume < y.volume ? 1 : -1))
        .slice(0, 50)
        .map(({ volume, ...v }) => ({ ...v, volumeUsdc: usdc(volume) })),
    };
  }

  async function tick(): Promise<void> {
    const first = updatedAt === undefined;
    const started = Date.now();
    try {
      await sync();
      if (first) {
        const s = snapshot();
        log(
          `[metrics] Lectura inicial lista en ${Math.round((Date.now() - started) / 1000)} s: ` +
            `${s.totals.vaults} vaults, ${s.totals.payments} pagos, ${s.totals.distributions} repartos (bloque ${s.syncedBlock})`
        );
      }
    } catch (error) {
      log(`[metrics] Error al leer la cadena (reintenta en el siguiente ciclo): ${(error as Error).message}`);
    }
  }

  return {
    sync,
    snapshot,
    start() {
      if (timer) return;
      log(`[metrics] Leyendo eventos desde el bloque ${fromBlock} (cada ${options.syncSeconds ?? 60} s)`);
      void tick();
      timer = setInterval(() => void tick(), (options.syncSeconds ?? 60) * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
