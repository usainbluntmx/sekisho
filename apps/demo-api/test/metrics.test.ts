import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hash } from "viem";
import {
  createMetricsIndexer,
  type DistributedLog,
  type MetricsSource,
  type TransferLog,
  type VaultCreatedLog,
} from "../src/metrics.js";

// Cadena simulada: listas de eventos y una RPC que puede rechazar rangos grandes
const FACTORY = "0x00000000000000000000000000000000000000fa" as Address;
const USDC = "0x00000000000000000000000000000000000000cc" as Address;
const VAULT_A = "0x000000000000000000000000000000000000000A" as Address;
const VAULT_B = "0x000000000000000000000000000000000000000b" as Address;
const MERCHANT = "0x0000000000000000000000000000000000000001" as Address;
const OWN = "0x0000000000000000000000000000000000000002" as Address;
const EXTERNAL = "0x0000000000000000000000000000000000000003" as Address;
const NOW = Math.floor(Date.now() / 1000);

const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;

function fakeChain(opts: { head: bigint; maxRange?: bigint }) {
  const created: VaultCreatedLog[] = [];
  const direct = new Set<Hash>(); // txs que NO son transferWithAuthorization
  const transfers: TransferLog[] = [];
  const dists: DistributedLog[] = [];
  const calls = { logs: 0, rejected: 0 };
  const check = (a: bigint, b: bigint) => {
    calls.logs++;
    if (opts.maxRange && b - a + 1n > opts.maxRange) {
      calls.rejected++;
      throw new Error("query exceeds max block range");
    }
  };
  const inRange = (block: bigint, a: bigint, b: bigint) => block >= a && block <= b;
  const source: MetricsSource = {
    blockNumber: async () => opts.head,
    blockTime: async (block) => NOW - Number(opts.head - block), // 1 s por bloque
    txSelector: async (hash) => (direct.has(hash) ? "0xa9059cbb" : "0xe3ee160e"),
    vaultsCreated: async (a, b) => (check(a, b), created.filter((v) => inRange(v.block, a, b))),
    transfersTo: async (vaults, a, b) => (check(a, b), transfers.filter((t) => vaults.includes(t.to) && inRange(t.block, a, b))),
    distributions: async (vaults, a, b) => (check(a, b), dists.filter((d) => vaults.includes(d.vault) && inRange(d.block, a, b))),
  };
  let n = 0;
  return {
    source,
    calls,
    vault: (vault: Address, block: bigint) => created.push({ vault, merchant: MERCHANT, block, tx: tx(++n) }),
    pay: (to: Address, from: Address, usdc: number, block: bigint, kind: "x402" | "direct" = "x402") => {
      const hash = tx(++n);
      if (kind === "direct") direct.add(hash);
      transfers.push({ from, to, value: BigInt(usdc * 1e6), block, tx: hash, logIndex: 0 });
    },
    distribute: (vault: Address, usdc: number, block: bigint) => {
      const total = BigInt(usdc * 1e6);
      const fee = (total * 150n) / 10_000n;
      dists.push({ vault, total, fee, merchantAmount: total - fee, block, tx: tx(++n), logIndex: 1 });
    },
  };
}

function indexer(source: MetricsSource, extra: { maxRange?: number } = {}) {
  return createMetricsIndexer({
    source,
    network: "avalancheFuji",
    chainId: 43113,
    factory: FACTORY,
    usdc: USDC,
    fromBlock: 100n,
    ownWallets: [OWN],
    maxRange: extra.maxRange ?? 1000,
    log: () => {},
  });
}

test("cuenta pagos, repartos, pendiente y separa pagadores externos de los propios", async () => {
  const chain = fakeChain({ head: 1000n });
  chain.vault(VAULT_A, 150n);
  chain.pay(VAULT_A, OWN, 1, 200n, "direct"); // p. ej. la prueba del deployer con transfer()
  chain.pay(VAULT_A, EXTERNAL, 2, 300n);
  chain.distribute(VAULT_A, 3, 400n);
  chain.pay(VAULT_A, EXTERNAL, 0.5, 500n);
  chain.pay("0x00000000000000000000000000000000000000ff", EXTERNAL, 9, 600n); // no es un vault: no cuenta

  const metrics = indexer(chain.source);
  assert.equal(metrics.snapshot().syncing, true);
  await metrics.sync();
  const s = metrics.snapshot();

  assert.equal(s.syncing, false);
  assert.equal(s.syncedBlock, "1000");
  assert.equal(s.totals.vaults, 1);
  assert.equal(s.totals.payments, 3);
  assert.equal(s.totals.volumeUsdc, "3.5");
  assert.equal(s.totals.payers, 2);
  assert.equal(s.totals.x402Payments, 2);
  assert.equal(s.totals.x402VolumeUsdc, "2.5");
  assert.equal(s.totals.distributions, 1);
  assert.equal(s.totals.distributedUsdc, "3");
  assert.equal(s.totals.feesUsdc, "0.045");
  assert.equal(s.totals.toMerchantsUsdc, "2.955");
  assert.equal(s.totals.pendingUsdc, "0.5");
  assert.deepEqual(s.external, { payments: 2, x402Payments: 2, volumeUsdc: "2.5", payers: 1 });
  assert.equal(s.recent[0].amountUsdc, "0.5", "el más reciente primero");
  assert.equal(s.recent.find((p) => p.payer === OWN)?.external, false);
  assert.equal(s.recent.find((p) => p.payer === OWN)?.kind, "direct");
  assert.equal(s.recent[0].kind, "x402");
  assert.equal(s.vaults[0].pendingUsdc, "0.5");
  assert.equal(s.daily.length, 30);
  assert.equal(s.daily.at(-1)?.payments, 3);
  assert.equal(s.daily.at(-1)?.externalPayments, 2);
});

test("recupera pagos que llegaron al vault antes de desplegarse", async () => {
  const chain = fakeChain({ head: 2000n });
  chain.pay(VAULT_B, EXTERNAL, 1, 120n); // pago a la dirección predicha
  chain.pay(VAULT_B, EXTERNAL, 1, 900n);
  chain.vault(VAULT_B, 1500n); // el vault se crea después, en otro tramo
  chain.distribute(VAULT_B, 2, 1500n);

  const metrics = indexer(chain.source, { maxRange: 200 });
  await metrics.sync();
  const s = metrics.snapshot();
  assert.equal(s.totals.payments, 2);
  assert.equal(s.totals.volumeUsdc, "2");
  assert.equal(s.totals.pendingUsdc, "0");
});

test("si la RPC rechaza el rango, lo parte y termina igual", async () => {
  const chain = fakeChain({ head: 5000n, maxRange: 300n });
  chain.vault(VAULT_A, 101n);
  chain.pay(VAULT_A, EXTERNAL, 1, 4999n);

  const metrics = indexer(chain.source, { maxRange: 2048 });
  await metrics.sync();
  assert.ok(chain.calls.rejected > 0, "debió haber rechazos");
  assert.equal(metrics.snapshot().totals.payments, 1);
  assert.equal(metrics.snapshot().syncedBlock, "5000");
});

test("la siguiente lectura solo pide bloques nuevos y no duplica pagos", async () => {
  const head = { value: 1000n };
  const chain = fakeChain({ head: 0n });
  chain.source.blockNumber = async () => head.value;
  chain.vault(VAULT_A, 150n);
  chain.pay(VAULT_A, EXTERNAL, 1, 500n);

  const metrics = indexer(chain.source);
  await metrics.sync();
  const before = chain.calls.logs;
  await metrics.sync(); // sin bloques nuevos
  assert.equal(chain.calls.logs, before);

  chain.pay(VAULT_A, EXTERNAL, 1, 1100n);
  head.value = 1200n;
  await Promise.all([metrics.sync(), metrics.sync()]); // simultáneas: una sola lectura
  assert.equal(metrics.snapshot().totals.payments, 2);
  assert.equal(metrics.snapshot().syncedBlock, "1200");
});

test("si la RPC falla, conserva lo leído y sigue en la siguiente lectura", async () => {
  const chain = fakeChain({ head: 1000n });
  chain.vault(VAULT_A, 150n);
  chain.pay(VAULT_A, EXTERNAL, 1, 500n);
  const original = chain.source.transfersTo;
  chain.source.transfersTo = async () => {
    throw new Error("rpc down");
  };

  const metrics = indexer(chain.source);
  await assert.rejects(metrics.sync());
  assert.equal(metrics.snapshot().syncing, true);

  chain.source.transfersTo = original;
  await metrics.sync();
  assert.equal(metrics.snapshot().totals.payments, 1);
});

test("la fuente real arma bien los filtros de eth_getLogs", async () => {
  const { createPublicClient, custom, encodeAbiParameters, pad, toEventSelector } = await import("viem");
  const { viemMetricsSource } = await import("../src/metrics.js");
  const requests: any[] = [];
  const transferTopic = toEventSelector("Transfer(address,address,uint256)");
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params: any }) {
        requests.push({ method, params });
        if (method === "eth_getTransactionByHash") {
          return { hash: params[0], input: "0xE3EE160E0000", from: EXTERNAL, to: USDC, blockNumber: "0x10", type: "0x2", gas: "0x1", nonce: "0x0", value: "0x0" };
        }
        if (method !== "eth_getLogs") throw new Error(method);
        if (params[0].address === USDC) {
          return [
            {
              address: USDC,
              topics: [transferTopic, pad(EXTERNAL), pad(VAULT_A)],
              data: encodeAbiParameters([{ type: "uint256" }], [10_000n]),
              blockNumber: "0x10",
              transactionHash: tx(7),
              logIndex: "0x2",
              blockHash: tx(8),
              transactionIndex: "0x0",
              removed: false,
            },
          ];
        }
        return [];
      },
    }),
  });
  const source = viemMetricsSource(client as any, { factory: FACTORY, usdc: USDC });

  const transfers = await source.transfersTo([VAULT_A, VAULT_B], 10n, 20n);
  assert.deepEqual(transfers, [
    { from: EXTERNAL, to: VAULT_A, value: 10_000n, block: 16n, tx: tx(7), logIndex: 2 },
  ]);
  const t = requests[0].params[0];
  assert.equal(t.fromBlock, "0xa");
  assert.equal(t.toBlock, "0x14");
  assert.equal(t.topics[0], transferTopic);
  assert.equal(t.topics[1], null);
  assert.deepEqual(t.topics[2], [pad(VAULT_A), pad(VAULT_B)].map((x) => x.toLowerCase()));

  await source.distributions([VAULT_A], 10n, 20n);
  const d = requests[1].params[0];
  assert.deepEqual(d.address, [VAULT_A]);
  assert.equal(d.topics[0], toEventSelector("Distributed(address,uint256,uint256,uint256)"));
  assert.equal(d.topics[1], pad(USDC).toLowerCase());

  await source.vaultsCreated(10n, 20n);
  assert.equal(requests[2].params[0].address, FACTORY);
  assert.equal(requests[2].params[0].topics[0], toEventSelector("VaultCreated(address,address)"));

  assert.equal(await source.txSelector(tx(7)), "0xe3ee160e");
  assert.equal(requests[3].method, "eth_getTransactionByHash");
});
