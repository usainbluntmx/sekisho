import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, parseUnits, type Address, type Hash } from "viem";
import { evaluate } from "../src/rules.js";
import { emptyState, loadState, planNotification, saveState } from "../src/state.js";
import { formatNotification, formatReport } from "../src/report.js";
import { chunks, sendTelegram, telegramFromEnv } from "../src/telegram.js";
import type { Facts, Watch } from "../src/types.js";
import watchJson from "../watch.json" with { type: "json" };

const rules = (watchJson as unknown as Watch).rules;
const NOW = new Date("2026-11-02T14:00:00Z");
const OP = "0xb4841B636051fE20748E6723a5dB9336b5568732" as Address;
const MERCHANT = "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae" as Address;
const VAULT = "0xBF15daBBA09b63ee956c06C0234F8992443B8e36" as Address;
const TX = `0x${"ab".repeat(32)}` as Hash;

function healthy(): Facts {
  return {
    at: NOW,
    balances: [{ network: "avalanche", label: "operador sekisho-api", address: OP, wei: parseEther("0.09"), minWei: parseEther("0.05") }],
    vaults: [
      {
        network: "avalanche",
        label: "sekisho-api",
        merchant: MERCHANT,
        vault: VAULT,
        deployed: true,
        pending: parseUnits("0.01", 6),
        splitAt: parseUnits("1", 6),
        lastPaymentAt: new Date("2026-10-28T03:53:19Z"),
      },
    ],
    endpoints: [{ label: "Sekisho API", url: "https://x/health", ok: true, status: 200, ms: 120 }],
    metrics: {
      syncing: false,
      syncedBlock: 1000n,
      chainHead: 1010n,
      totalPayments: 3,
      x402Payments: 2,
      externalPayments: 0,
      last24h: { payments: 0, external: 0, x402: 0, capped: false },
    },
    admin: [],
    adminScannedTo: { avalanche: 1010n },
    services: [{ id: "avalanche-snapshot-http", name: "Avalanche snapshot", problems: [] }],
    ci: { id: 49, status: "completed", conclusion: "success", title: "chore", sha: "4bf541e00", url: "https://ci" },
    errors: [],
  };
}

test("un sistema sano no genera alertas (polvo viejo en el vault no cuenta)", () => {
  assert.deepEqual(evaluate(healthy(), rules), []);
});

test("cada regla genera su alerta con clave estable", () => {
  const f = healthy();
  f.balances[0].wei = parseEther("0.01");
  f.endpoints[0] = { label: "Sekisho API", url: "https://x/health", ok: false, status: 502 };
  f.vaults.push({ ...f.vaults[0], network: "avalancheFuji", label: "Café Kanjō", pending: parseUnits("6", 6), splitAt: parseUnits("5", 6), lastPaymentAt: null });
  f.metrics!.chainHead = 5000n;
  f.admin.push({ network: "avalanche", contract: "safe", event: "ExecutionSuccess", tx: TX, block: 999n });
  f.ci = { ...f.ci!, conclusion: "failure" };
  f.errors.push({ key: "metrics", text: "las métricas: HTTP 500" });
  f.services[0].problems.push("precio 20000 atómico ≠ 10000 (0.01 USDC)");

  const keys = evaluate(f, rules).map((a) => a.key);
  assert.deepEqual(keys, [
    `avax:avalanche:${OP.toLowerCase()}`,
    "down:Sekisho API",
    `split:avalancheFuji:${MERCHANT.toLowerCase()}`,
    "metrics:lag",
    `admin:${TX}:ExecutionSuccess`,
    "service:avalanche-snapshot-http",
    "ci:49",
    "error:metrics",
  ]);
});

test("reparto atrasado por antigüedad: ≥ 0.25 USDC y último pago hace más de 26 h", () => {
  const f = healthy();
  f.vaults[0].pending = parseUnits("0.30", 6);
  assert.equal(evaluate(f, rules)[0]?.key, `stale:avalanche:${MERCHANT.toLowerCase()}`);
  f.vaults[0].lastPaymentAt = new Date(NOW.getTime() - 3_600_000); // hace 1 h: todavía no toca
  assert.deepEqual(evaluate(f, rules), []);
});

test("el CI en curso no alerta; el indexador en lectura inicial tampoco", () => {
  const f = healthy();
  f.ci = { ...f.ci!, status: "in_progress", conclusion: null };
  f.metrics = { ...f.metrics!, syncing: true, chainHead: 999_999n };
  assert.deepEqual(evaluate(f, rules), []);
});

test("avisos: nueva → se envía; sigue igual → silencio; tras 6 h → recordatorio; se arregla → resuelta", () => {
  const alert = { key: "down:Kanjō", text: "Kanjō no responde" };
  const t0 = NOW;
  const p1 = planNotification(emptyState(), [alert], t0, 6);
  assert.deepEqual([p1.opened.length, p1.shouldSend], [1, true]);

  const p2 = planNotification(p1.next, [alert], new Date(t0.getTime() + 30 * 60_000), 6);
  assert.equal(p2.shouldSend, false);

  const p3 = planNotification(p2.next, [alert], new Date(t0.getTime() + 6 * 3_600_000), 6);
  assert.deepEqual([p3.ongoing.length, p3.shouldSend], [1, true]);
  assert.equal(p3.next.alerts[alert.key].since, t0.toISOString(), "conserva desde cuándo está abierta");

  const p4 = planNotification(p3.next, [], new Date(t0.getTime() + 7 * 3_600_000), 6);
  assert.deepEqual(p4.resolved, ["Kanjō no responde"]);
  assert.deepEqual(p4.next.alerts, {});
});

test("los eventos de administración se avisan una vez y no aparecen como 'resueltos'", () => {
  const admin = { key: `admin:${TX}:FeeUpdated`, text: "FeeUpdated" };
  const p1 = planNotification(emptyState(), [admin], NOW, 6);
  const p2 = planNotification(p1.next, [], new Date(NOW.getTime() + 60_000), 6);
  assert.deepEqual([p2.resolved, p2.shouldSend], [[], false]);
});

test("el estado se guarda y se recupera; uno dañado no rompe el monitor", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-"));
  const path = join(dir, "nested", "state.json");
  const state = planNotification(emptyState(), [{ key: "k", text: "t" }], NOW, 6).next;
  state.adminScannedTo.avalanche = "123";
  saveState(path, state);
  assert.deepEqual(loadState(path), state);
  writeFileSync(path, "{no es json");
  assert.deepEqual(loadState(path), emptyState());
});

test("el reporte y el aviso salen en texto plano con lo esencial", () => {
  const f = healthy();
  const report = formatReport(f, []);
  assert.match(report, /Estado: OK, sin alertas/);
  assert.match(report, /0\.0900 AVAX \(mín 0\.0500\)/);
  assert.match(report, /0\.01 USDC \(reparte desde 1\)/);
  assert.match(report, /Histórico: 3 pagos \(2 x402, 0 externos\)/);
  const msg = formatNotification(
    { opened: [{ key: "a", text: "nueva" }], ongoing: [], resolved: ["vieja"], shouldSend: true, next: emptyState() },
    NOW
  );
  assert.match(msg, /🔴 Nuevas\n• nueva/);
  assert.match(msg, /🟢 Resueltas\n• vieja/);
});

test("Telegram: valida el token, parte mensajes largos y nunca expone el token en errores", async () => {
  assert.equal(telegramFromEnv({}), undefined);
  assert.throws(() => telegramFromEnv({ TELEGRAM_BOT_TOKEN: "malo", TELEGRAM_CHAT_ID: "1" }));
  const token = `123456:${"A".repeat(35)}`;
  const config = telegramFromEnv({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "42" })!;

  const parts = chunks(Array.from({ length: 300 }, (_, i) => `línea ${i} ${"x".repeat(20)}`).join("\n"), 1000);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1000));

  const sent: any[] = [];
  const ok = (async (url: string, init: any) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await sendTelegram(config, "hola", ok);
  assert.deepEqual(sent[0].body, { chat_id: "42", text: "hola", disable_web_page_preview: true });

  const denied = (async () => new Response(JSON.stringify({ description: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(sendTelegram(config, "hola", denied), (error: Error) => {
    assert.match(error.message, /401: Unauthorized/);
    assert.ok(!error.message.includes(token), "el error no debe incluir el token");
    return true;
  });
});

test("endpoint con respuesta esperada: la página de pago de Kanjō", async () => {
  const { endpointProblem } = await import("../src/collect.js");
  const expect = { status: 404, contentType: "text/html" };
  assert.equal(endpointProblem(expect, 404, "text/html; charset=UTF-8"), null);
  // El 404 genérico de Hono (texto plano) significa que la ruta desapareció
  assert.equal(endpointProblem(expect, 404, "text/plain; charset=UTF-8"), "esperaba HTTP 404 text/html, llegó HTTP 404 text/plain");
  assert.match(endpointProblem(expect, 502, null)!, /llegó HTTP 502 sin content-type/);
  // Sin expect: cualquier 2xx está bien
  assert.equal(endpointProblem(undefined, 200, "text/html"), null);
  assert.equal(endpointProblem(undefined, 503, "text/html"), "HTTP 503");
  const page = (watchJson as Watch).endpoints.find((e) => e.url.includes("/pay/"));
  assert.deepEqual(page?.expect, expect);
});
