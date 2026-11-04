import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSekishoFetch } from "@zero-two-labs/sekisho";
import { createDemoApp } from "../src/app.js";
import { fakeSekisho, MERCHANT, strictFacilitator } from "../interop/fixtures.js";

// Con el facilitador estricto (verifica la firma EIP-3009 de verdad). Los clientes de terceros
// (@x402/fetch puro y Python) se prueban contra este mismo servidor en el job "Interop" del CI.
const BASE = "http://interop.test";

async function setup() {
  const strict = strictFacilitator();
  const { app } = await createDemoApp({
    sekisho: fakeSekisho(),
    facilitator: strict.facilitator,
    network: "avalancheFuji",
    merchant: MERCHANT,
    priceUsdc: "0.01",
    ratePerMinute: 1000,
    snapshot: async () => ({ ok: true }),
    log: () => {},
  });
  const fetchApp = async (input: RequestInfo | URL, init?: RequestInit) => app.request(new Request(input, init));
  return { strict, fetchApp };
}

async function withAppFetch<T>(fetchApp: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = fetchApp;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("el SDK firma una autorización que pasa la verificación estricta (dominio, monto, destino)", async () => {
  const { strict, fetchApp } = await setup();
  const account = privateKeyToAccount(generatePrivateKey());
  const res = await withAppFetch(fetchApp as typeof fetch, async () => {
    const { fetch: pay } = createSekishoFetch({ account, maxPerPayment: "0.01" });
    return pay(`${BASE}/v1/avalanche/snapshot`);
  });
  assert.equal(res.status, 200);
  assert.deepEqual(strict.calls.rejected, []);
  assert.equal(strict.calls.settle, 1);
});

test("una autorización alterada o repetida se rechaza", async () => {
  const { strict, fetchApp } = await setup();
  const account = privateKeyToAccount(generatePrivateKey());

  // Captura el header de pago que firma el SDK y reenvíalo alterado y repetido
  let paymentHeader = "";
  const capture = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    paymentHeader = request.headers.get("payment-signature") ?? paymentHeader;
    return fetchApp(request);
  }) as typeof fetch;
  const ok = await withAppFetch(capture, async () => {
    const { fetch: pay } = createSekishoFetch({ account, maxPerPayment: "0.01" });
    return pay(`${BASE}/v1/avalanche/snapshot`);
  });
  assert.equal(ok.status, 200);
  assert.ok(paymentHeader, "el SDK debió mandar PAYMENT-SIGNATURE");

  const replay = await fetchApp(`${BASE}/v1/avalanche/snapshot`, { headers: { "payment-signature": paymentHeader } });
  assert.equal(replay.status, 402, "el mismo nonce no se puede usar dos veces");

  const payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
  payload.payload.authorization.to = "0x000000000000000000000000000000000000dEaD"; // otro destino, misma firma
  const tampered = Buffer.from(JSON.stringify(payload)).toString("base64");
  const res = await fetchApp(`${BASE}/v1/avalanche/snapshot`, { headers: { "payment-signature": tampered } });
  assert.equal(res.status, 402);
  assert.ok(strict.calls.rejected.some((r) => r.includes("nonce ya usado")));
  assert.ok(strict.calls.rejected.some((r) => r.includes("payTo") || r.includes("firma")));
});
