import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { checkAccepts, probeService, validateDirectory, type Directory, type Service } from "../src/services.js";

const directory = JSON.parse(readFileSync(new URL("../../apps/web/public/services.json", import.meta.url), "utf8")) as Directory;
const http = directory.services.find((s) => s.kind === "http")!;

test("el directorio publicado en el sitio es válido", () => {
  assert.deepEqual(validateDirectory(directory), []);
  assert.ok(directory.services.length >= 2);
});

test("el validador detecta entradas mal formadas", () => {
  const bad = structuredClone(directory);
  bad.services.push({ ...bad.services[0], url: "http://inseguro.example", payTo: "0x123", priceUsdc: "0" });
  const problems = validateDirectory(bad).join(" | ");
  assert.match(problems, /id repetido/);
  assert.match(problems, /url debe ser https/);
  assert.match(problems, /payTo no es una dirección/);
  assert.match(problems, /priceUsdc inválido/);
});

test("checkAccepts compara precio, red, USDC y payTo con lo prometido", () => {
  const ok = { scheme: "exact", network: http.network, asset: http.asset.toLowerCase(), amount: "10000", payTo: http.payTo };
  assert.deepEqual(checkAccepts(http, [ok]), []);
  assert.match(checkAccepts(http, [{ ...ok, amount: "20000" }]).join(), /precio 20000/);
  assert.match(checkAccepts(http, [{ ...ok, payTo: "0x000000000000000000000000000000000000dEaD" }]).join(), /payTo/);
  assert.match(checkAccepts(http, [{ ...ok, network: "eip155:8453" }]).join(), /no acepta pago en eip155:43114/);
  assert.match(checkAccepts(http, []).join(), /no pidió pago/);
});

test("probeService lee el 402 real de un servidor HTTP sin pagar", async () => {
  const accepts = [{ scheme: "exact", network: http.network, asset: http.asset, amount: "10000", payTo: http.payTo }];
  const server = createServer((_req, res) => {
    res.writeHead(402, { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const local: Service = { ...http, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/x` };
  try {
    assert.deepEqual(await probeService(local), []);
    assert.match((await probeService({ ...local, priceUsdc: "0.02" })).join(), /precio 10000 atómico ≠ 20000/);
  } finally {
    server.close();
  }
});
