import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, scaffold, validate } from "../index.mjs";

const CLI = fileURLToPath(new URL("../index.mjs", import.meta.url));
const MERCHANT = "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae";
const tmp = () => mkdtempSync(join(tmpdir(), "create-sekisho-"));

test("parseArgs lee carpeta y opciones", () => {
  assert.deepEqual(parseArgs(["mi-api", "--merchant", MERCHANT, "--network", "avalanche", "--price", "0.05"]), {
    dir: "mi-api",
    merchant: MERCHANT,
    network: "avalanche",
    price: "0.05",
  });
});

test("validate rechaza datos inválidos", () => {
  const ok = { dir: "mi-api", merchant: MERCHANT, network: "avalancheFuji", price: "0.01" };
  assert.equal(validate(ok), null);
  assert.match(validate({ ...ok, merchant: "0x123" }), /--merchant/);
  assert.match(validate({ ...ok, network: "mainnet" }), /--network/);
  assert.match(validate({ ...ok, price: "0" }), /--price/);
  assert.match(validate({ ...ok, price: "0.0000001" }), /--price/);
  assert.match(validate({ ...ok, dir: "mi api" }), /carpeta/);
});

test("scaffold crea el proyecto con .env privado y llave nueva", () => {
  const dir = join(tmp(), "mi-api");
  const target = scaffold({ dir, merchant: MERCHANT, network: "avalancheFuji", price: "0.02" });
  for (const file of ["package.json", "tsconfig.json", ".gitignore", ".env.example", ".env", "README.md", "src/server.ts", "src/pay.ts"]) {
    assert.ok(existsSync(join(target, file)), `falta ${file}`);
  }
  assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).name, "mi-api");
  const env = readFileSync(join(target, ".env"), "utf8");
  assert.match(env, /^OPERATOR_PRIVATE_KEY=0x[0-9a-f]{64}$/m);
  assert.match(env, new RegExp(`^MERCHANT_ADDRESS=${MERCHANT}$`, "m"));
  assert.match(env, /^PRICE_USDC=0\.02$/m);
  assert.equal(statSync(join(target, ".env")).mode & 0o777, 0o600);
  assert.match(readFileSync(join(target, ".gitignore"), "utf8"), /^\.env$/m);
});

test("cada proyecto recibe una llave distinta", () => {
  const base = tmp();
  const key = (name) =>
    readFileSync(join(scaffold({ dir: join(base, name), merchant: MERCHANT, network: "avalancheFuji", price: "0.01" }), ".env"), "utf8").match(/OPERATOR_PRIVATE_KEY=(\S+)/)[1];
  assert.notEqual(key("a"), key("b"));
});

test("no pisa una carpeta con archivos", () => {
  const dir = join(tmp(), "ocupada");
  mkdirSync(dir);
  writeFileSync(join(dir, "algo.txt"), "x");
  assert.throws(() => scaffold({ dir, merchant: MERCHANT, network: "avalancheFuji", price: "0.01" }), /no está vacía/);
});

test("el comando crea el proyecto y no imprime la llave", () => {
  const cwd = tmp();
  const out = execFileSync(process.execPath, [CLI, "demo", "--merchant", MERCHANT], { cwd, encoding: "utf8" });
  const key = readFileSync(join(cwd, "demo", ".env"), "utf8").match(/OPERATOR_PRIVATE_KEY=(\S+)/)[1];
  assert.match(out, /Proyecto creado/);
  assert.ok(!out.includes(key.slice(2)), "la llave no debe aparecer en la salida");
});

test("el comando falla con un merchant inválido", () => {
  assert.throws(() => execFileSync(process.execPath, [CLI, "demo", "--merchant", "nope"], { cwd: tmp(), stdio: "pipe" }));
});
