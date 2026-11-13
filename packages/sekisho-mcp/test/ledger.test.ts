import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SpendLedger, type SpendEntry } from "../src/ledger.js";

const NET = "eip155:43113";
const entry = (amount: number, tool = "cheap"): SpendEntry => ({ at: new Date().toISOString(), network: NET, amount: String(amount), tool });
const fresh = () => join(mkdtempSync(join(tmpdir(), "sekisho-ledger-")), "spend.json");

test("reserve revisa el tope y registra en un solo paso, también entre dos instancias", () => {
  const file = fresh();
  const a = new SpendLedger(file);
  const b = new SpendLedger(file);
  assert.equal(a.reserve(entry(6), 10n).ok, true);
  const refused = b.reserve(entry(6), 10n);
  assert.equal(refused.ok, false);
  assert.equal(refused.spent, 6n);
  assert.equal(b.reserve(entry(4), 10n).ok, true);
  assert.equal(a.spentLast24h(NET), 10n);
});

test("attachTx de un proceso no borra lo que otro registró mientras tanto (SEKISHO-BUG-012)", () => {
  const file = fresh();
  const a = new SpendLedger(file);
  const b = new SpendLedger(file);
  a.reserve(entry(1, "tool-a"), 100n);
  b.reserve(entry(2, "tool-b"), 100n); // otra sesión paga después
  a.attachTx("tool-a", "0xaaa");
  const saved = JSON.parse(readFileSync(file, "utf8")).entries as SpendEntry[];
  assert.equal(saved.length, 2, "el pago de la otra sesión sigue ahí");
  assert.equal(saved.find((e) => e.tool === "tool-a")?.tx, "0xaaa");
  assert.equal(a.spentLast24h(NET), 3n);
});

test("un candado abandonado (proceso caído) se quita; uno vigente hace esperar y luego rechaza sin pagar", () => {
  const file = fresh();
  const ledger = new SpendLedger(file, { lockTimeoutMs: 150, staleLockMs: 1_000 });
  writeFileSync(`${file}.lock`, "999999");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, old, old);
  assert.equal(ledger.reserve(entry(1), 10n).ok, true, "el candado viejo no bloquea para siempre");
  assert.equal(existsSync(`${file}.lock`), false, "y se suelta al terminar");

  writeFileSync(`${file}.lock`, "123"); // otro proceso lo tiene ahora mismo
  assert.throws(() => ledger.reserve(entry(1), 10n), /ocupado por otro proceso; no se pagó/);
  assert.equal(ledger.spentLast24h(NET), 1n, "lo rechazado no se registró");
});

test("8 procesos a la vez contra el mismo registro: nunca se pasa del tope", async () => {
  const file = fresh();
  const ledgerPath = resolve("src/ledger.ts");
  // Cada proceso intenta 5 pagos de 1 con tope 20: hay 40 intentos para 20 de cupo
  const script = `
    const { SpendLedger } = await import(${JSON.stringify(ledgerPath)});
    const l = new SpendLedger(${JSON.stringify(file)}, { lockTimeoutMs: 20000 });
    let ok = 0;
    for (let i = 0; i < 5; i++) {
      if (l.reserve({ at: new Date().toISOString(), network: "${NET}", amount: "1", tool: "t" }, 20n).ok) ok++;
    }
    process.stdout.write(String(ok));
  `;
  const run = () =>
    new Promise<number>((done, fail) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("exit", (code) => (code === 0 ? done(Number(out)) : fail(new Error(`proceso salió con ${code}`))));
    });
  const approved = (await Promise.all(Array.from({ length: 8 }, run))).reduce((a, b) => a + b, 0);
  const saved = JSON.parse(readFileSync(file, "utf8")).entries as SpendEntry[];
  assert.equal(approved, 20, "se aprueban exactamente los 20 de cupo");
  assert.equal(saved.length, 20, "y quedan exactamente 20 registrados");
  assert.equal(new SpendLedger(file).spentLast24h(NET), 20n);
});
