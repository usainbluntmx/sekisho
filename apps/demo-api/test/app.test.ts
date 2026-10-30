import { test } from "node:test";
import assert from "node:assert/strict";
import type { x402Facilitator } from "@x402/core/facilitator";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORKS, createSekishoFetch, createSekishoMcpClient, type SekishoClient } from "@zero-two-labs/sekisho";
import { createDemoApp } from "../src/app.js";

// Todo offline: cliente de Sekisho y facilitador simulados, el agente firma de verdad (EIP-3009)
const FUJI = NETWORKS.avalancheFuji;
const MERCHANT = "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae" as const;
const VAULT = "0x449d38883418c750DFF8D1a4DF183d6A276789a0" as const;
const TX = `0x${"cd".repeat(32)}` as const;
const BASE = "http://demo.test";

function setup(ratePerMinute = 100) {
  const calls = { verify: 0, settle: 0, distribute: 0 };
  let pendingAtomic = 0n;
  const sekisho = {
    network: "avalancheFuji",
    config: FUJI,
    getPayTo: async () => VAULT,
    getConfig: async () => ({ feeBps: 150, feeChange: null }),
    pending: async () => ({ vault: VAULT, deployed: true, total: pendingAtomic, fee: 0n, merchantAmount: pendingAtomic }),
    distribute: async () => {
      calls.distribute++;
      pendingAtomic = 0n;
      return TX;
    },
  } as unknown as SekishoClient;

  const facilitator = {
    verify: async (payload: any) => {
      calls.verify++;
      return { isValid: true, payer: payload.payload.authorization.from };
    },
    settle: async (payload: any, requirements: any) => {
      calls.settle++;
      pendingAtomic += BigInt(requirements.amount);
      return { success: true, transaction: TX, network: requirements.network, payer: payload.payload.authorization.from };
    },
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:43113" }], extensions: [], signers: {} }),
  } as unknown as x402Facilitator;

  const logs: string[] = [];
  const ready = createDemoApp({
    sekisho,
    facilitator,
    network: "avalancheFuji",
    merchant: MERCHANT,
    priceUsdc: "0.01",
    ratePerMinute,
    distributionPolicy: { minUsdc: "0.01" },
    snapshot: async () => ({ chainId: 43113, block: { number: "1" } }),
    log: (m) => logs.push(m),
  });
  const fetchApp = async (input: RequestInfo | URL, init?: RequestInit) => (await ready).app.request(new Request(input, init));
  return { ready, calls, logs, fetchApp };
}

test("GET / describe el servicio y cómo pagar", async () => {
  const { fetchApp } = setup();
  const res = await fetchApp(`${BASE}/`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.caip2, "eip155:43113");
  assert.equal(body.payment.payTo, VAULT);
  assert.equal(body.payment.price, "0.01");
  assert.ok(body.endpoints.mcp.tools.avalanche_snapshot);
});

test("GET /health responde sin pasar por el límite", async () => {
  const { fetchApp } = setup(1);
  for (let i = 0; i < 3; i++) assert.equal((await fetchApp(`${BASE}/health`)).status, 200);
});

test("el endpoint de pago sin firma responde 402 con payTo y monto", async () => {
  const { fetchApp, calls } = setup();
  const res = await fetchApp(`${BASE}/v1/avalanche/snapshot`);
  assert.equal(res.status, 402);
  const header = res.headers.get("payment-required");
  assert.ok(header, "falta el header PAYMENT-REQUIRED");
  const required = JSON.parse(Buffer.from(header!, "base64").toString()) as any;
  assert.equal(required.accepts[0].payTo, VAULT);
  assert.equal(required.accepts[0].amount, "10000");
  assert.equal(required.accepts[0].asset, FUJI.usdc);
  assert.equal(calls.settle, 0);
});

test("un agente paga: 402 → firma → 200, se liquida una vez y se reparte", async () => {
  const { fetchApp, calls, logs } = setup();
  const account = privateKeyToAccount(generatePrivateKey());
  // El fetch del agente apunta a la app en memoria (createSekishoFetch toma el fetch global al crearse)
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchApp as typeof fetch;
  const { fetch: pay } = createSekishoFetch({ account, maxPerPayment: "0.01" });
  try {
    const res = await pay(`${BASE}/v1/avalanche/snapshot`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.paidTo, VAULT);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.verify, 1);
  assert.equal(calls.settle, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.distribute, 1, "el repartidor debió repartir al llegar al umbral");
  assert.ok(logs.some((l) => l.includes("[pago] 0.01 USDC")));
});

test("un agente con tope menor al precio no paga", async () => {
  const { fetchApp, calls } = setup();
  const account = privateKeyToAccount(generatePrivateKey());
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchApp as typeof fetch;
  const { fetch: pay } = createSekishoFetch({ account, maxPerPayment: "0.005" });
  try {
    await assert.rejects(() => pay(`${BASE}/v1/avalanche/snapshot`));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.settle, 0);
});

test("límite por IP: la petición 4 de la misma IP recibe 429", async () => {
  const { fetchApp } = setup(3);
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await fetchApp(`${BASE}/`, { headers: { "cf-connecting-ip": "1.2.3.4" } })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal((await fetchApp(`${BASE}/`, { headers: { "cf-connecting-ip": "5.6.7.8" } })).status, 200);
});

test("MCP: ping gratis y avalanche_snapshot cobrado", async () => {
  const { fetchApp, calls } = setup();
  const free = new Client({ name: "test", version: "1" });
  await free.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: fetchApp as typeof fetch }));
  const tools = (await free.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["avalanche_snapshot", "ping"]);
  const pong = await free.callTool({ name: "ping", arguments: {} });
  assert.deepEqual(pong.content, [{ type: "text", text: "pong" }]);
  await free.close();

  const account = privateKeyToAccount(generatePrivateKey());
  const agent = createSekishoMcpClient({ account, maxPerPayment: "0.01" });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: fetchApp as typeof fetch }));
  const result = await agent.callTool("avalanche_snapshot", {});
  assert.equal(result.paymentMade, true);
  assert.equal(result.paymentResponse?.transaction, TX);
  assert.equal(calls.settle, 1);
  await agent.close();
});

test("MCP rechaza bodies de más de 64 KB", async () => {
  const { fetchApp } = setup();
  const res = await fetchApp(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70 * 1024) } }),
  });
  assert.equal(res.status, 413);
});
