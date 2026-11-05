import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createSekishoMcpPaywall } from "@zero-two-labs/sekisho";
import { parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig, readPayerKey } from "../src/config.js";
import { SpendLedger } from "../src/ledger.js";
import { WALLET_TOOL, createProxy } from "../src/proxy.js";
import { fakeSekisho, MERCHANT, strictFacilitator } from "./fixtures.js";

// MCP remoto de pago, local: ping (gratis), cheap (0.01 USDC) y pricey (0.02 USDC).
// El facilitador verifica la firma EIP-3009 de verdad.
async function startPaidMcp() {
  const strict = strictFacilitator();
  const paywall = (price: string) =>
    createSekishoMcpPaywall({ sekisho: fakeSekisho(), facilitator: strict.facilitator, merchant: MERCHANT, price });
  const cheap = await paywall("0.01");
  const pricey = await paywall("0.02");

  const http: HttpServer = createServer(async (req, res) => {
    const server = new McpServer({ name: "paid-test", version: "1.0.0" });
    server.tool("ping", "Free", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
    server.tool("cheap", "Costs 0.01 USDC", {}, cheap(async () => ({ content: [{ type: "text", text: "cheap result" }] })));
    server.tool("pricey", "Costs 0.02 USDC", {}, pricey(async () => ({ content: [{ type: "text", text: "pricey result" }] })));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  return { url, strict, stop: () => new Promise<void>((resolve) => http.close(() => resolve())) };
}

async function startProxy(url: URL, caps: { perCall: string; perDay: string }, ledgerFile?: string) {
  const dir = mkdtempSync(join(tmpdir(), "sekisho-mcp-"));
  const ledger = new SpendLedger(ledgerFile ?? join(dir, "spend.json"));
  const proxy = await createProxy({
    url,
    account: privateKeyToAccount(generatePrivateKey()),
    network: "avalancheFuji",
    maxPerCall: parseUnits(caps.perCall, 6),
    maxPerDay: parseUnits(caps.perDay, 6),
    ledger,
    log: () => {},
  });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(remote);
  const client = new Client({ name: "editor", version: "1.0.0" });
  await client.connect(local);
  const call = async (name: string) => {
    const r = (await client.callTool({ name, arguments: {} })) as { content: { text?: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true };
  };
  return { client, call, ledger, dir, close: async () => { await client.close(); await proxy.close(); } };
}

test("expone las tools remotas más sekisho_wallet, y las gratis pasan sin pagar", async () => {
  const paid = await startPaidMcp();
  const p = await startProxy(paid.url, { perCall: "0.05", perDay: "1" });
  try {
    const { tools } = await p.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["cheap", "ping", "pricey", WALLET_TOOL].sort());
    const r = await p.call("ping");
    assert.deepEqual(r, { text: "pong", isError: false });
    assert.equal(paid.strict.calls.settle, 0);
  } finally {
    await p.close();
    await paid.stop();
  }
});

test("una tool de pago dentro del tope se paga con una firma válida y queda registrada", async () => {
  const paid = await startPaidMcp();
  const p = await startProxy(paid.url, { perCall: "0.05", perDay: "1" });
  try {
    const r = await p.call("cheap");
    assert.equal(r.isError, false);
    assert.match(r.text, /cheap result/);
    assert.match(r.text, /\[sekisho\] Paid with x402 on avalancheFuji · tx 0x/);
    assert.deepEqual(paid.strict.calls.rejected, []);
    assert.equal(paid.strict.calls.settle, 1);
    assert.equal(p.ledger.spentLast24h("eip155:43113"), 10_000n);
    const wallet = await p.call(WALLET_TOOL);
    assert.match(wallet.text, /spent: 0\.01 · left: 0\.99/);
  } finally {
    await p.close();
    await paid.stop();
  }
});

test("si la tool cuesta más que el tope por llamada, no firma y lo dice", async () => {
  const paid = await startPaidMcp();
  const p = await startProxy(paid.url, { perCall: "0.01", perDay: "1" });
  try {
    const r = await p.call("pricey");
    assert.equal(r.isError, true);
    assert.match(r.text, /cuesta 0\.02 USDC, más que tu tope por llamada \(0\.01\)/);
    assert.equal(paid.strict.calls.settle, 0);
    assert.equal(p.ledger.spentLast24h("eip155:43113"), 0n);
  } finally {
    await p.close();
    await paid.stop();
  }
});

test("el tope de 24 h se respeta y sobrevive a un reinicio del proxy", async () => {
  const paid = await startPaidMcp();
  const dir = mkdtempSync(join(tmpdir(), "sekisho-ledger-"));
  const ledgerFile = join(dir, "spend.json");
  const first = await startProxy(paid.url, { perCall: "0.01", perDay: "0.015" }, ledgerFile);
  try {
    assert.equal((await first.call("cheap")).isError, false);
    const second = await first.call("cheap");
    assert.equal(second.isError, true);
    assert.match(second.text, /Tope de 24 h alcanzado: llevas 0\.01 de 0\.015 USDC/);
  } finally {
    await first.close();
  }
  const restarted = await startProxy(paid.url, { perCall: "0.01", perDay: "0.015" }, ledgerFile);
  try {
    assert.equal((await restarted.call("cheap")).isError, true, "otro proceso con el mismo registro tampoco paga");
    assert.equal(paid.strict.calls.settle, 1);
  } finally {
    await restarted.close();
    await paid.stop();
  }
});

test("la llave solo se lee de un archivo privado (600) y con formato válido", () => {
  const dir = mkdtempSync(join(tmpdir(), "sekisho-key-"));
  const file = join(dir, "payer.key");
  writeFileSync(file, `${generatePrivateKey()}\n`);
  chmodSync(file, 0o644);
  assert.throws(() => readPayerKey(file), /lo pueden leer otros usuarios.*chmod 600/);
  chmodSync(file, 0o600);
  assert.match(readPayerKey(file), /^0x[0-9a-f]{64}$/);
  writeFileSync(file, "no es una llave");
  assert.throws(() => readPayerKey(file), /no contiene una llave/);
  assert.throws(() => readPayerKey(join(dir, "nada.key")), /No existe/);
});

test("la configuración valida URL, red y topes, y explica todos los problemas", () => {
  const ok = loadConfig({ SEKISHO_MCP_URL: "https://sekisho-api.zerotwolabs.xyz/mcp", SEKISHO_HOME: "/tmp/x" });
  assert.equal(ok.network, "avalancheFuji");
  assert.equal(ok.maxPerCall, 50_000n);
  assert.equal(ok.maxPerDay, 1_000_000n);
  assert.equal(ok.keyFile, "/tmp/x/payer.key");
  assert.throws(
    () => loadConfig({ SEKISHO_MCP_URL: "http://example.com/mcp", SEKISHO_NETWORK: "base", SEKISHO_MAX_PER_CALL: "2", SEKISHO_MAX_PER_DAY: "1" }),
    (e: Error) =>
      /https/.test(e.message) && /SEKISHO_NETWORK/.test(e.message) && /no puede ser mayor/.test(e.message)
  );
});
