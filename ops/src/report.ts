import { avax, short, usdc } from "./rules.js";
import type { NotifyPlan } from "./state.js";
import { NET_LABEL, type Alert, type Facts } from "./types.js";

const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Reporte completo para la terminal y el resumen diario. Texto plano: Telegram lo muestra igual. */
export function formatReport(facts: Facts, alerts: Alert[]): string {
  const lines: string[] = [];
  lines.push(`Sekisho · chequeo ${stamp(facts.at)}`);
  lines.push(alerts.length === 0 ? "Estado: OK, sin alertas" : `Estado: ${alerts.length} alerta(s)`);
  for (const a of alerts) lines.push(`  ⚠️ ${a.text}`);

  lines.push("", "Saldos de AVAX (operadores)");
  for (const b of facts.balances) {
    const mark = b.wei < b.minWei ? "⚠️" : "✅";
    lines.push(`  ${mark} ${NET_LABEL[b.network]} · ${b.label} ${short(b.address)}: ${avax(b.wei)} AVAX (mín ${avax(b.minWei)})`);
  }

  lines.push("", "Vaults (pendiente por repartir)");
  for (const v of facts.vaults) {
    const state = v.deployed ? "" : " (aún sin desplegar)";
    const last = v.lastPaymentAt ? ` · último pago ${stamp(v.lastPaymentAt)}` : "";
    lines.push(`  ${NET_LABEL[v.network]} · ${v.label} → ${short(v.vault)}${state}: ${usdc(v.pending)} USDC (reparte desde ${usdc(v.splitAt)})${last}`);
  }

  const m = facts.metrics;
  lines.push("", "Pagos en mainnet (de /v1/metrics)");
  if (m) {
    const more = m.last24h.capped ? "+" : "";
    lines.push(
      `  Últimas 24 h: ${m.last24h.payments}${more} pagos (${m.last24h.x402} x402, ${m.last24h.external} externos)`,
      `  Histórico: ${m.totalPayments} pagos (${m.x402Payments} x402, ${m.externalPayments} externos)`
    );
    if (m.syncing) lines.push("  Indexador: aún en lectura inicial");
    else if (m.syncedBlock !== null && m.chainHead !== null) {
      lines.push(`  Indexador: bloque ${m.syncedBlock} (retraso ${m.chainHead - m.syncedBlock} bloques)`);
    }
  } else lines.push("  (sin datos)");

  lines.push("", "Servicios");
  for (const e of facts.endpoints) {
    lines.push(`  ${e.ok ? "✅" : "⚠️"} ${e.label}: ${e.status ? `HTTP ${e.status}` : (e.error ?? "sin respuesta")}${e.ms !== undefined ? ` · ${e.ms} ms` : ""}`);
  }

  lines.push("", "Directorio de servicios (402 verificado sin pagar)");
  if (facts.services.length === 0) lines.push("  (sin datos)");
  for (const s of facts.services) lines.push(`  ${s.problems.length ? "⚠️" : "✅"} ${s.name}${s.problems.length ? `: ${s.problems.join("; ")}` : ""}`);

  lines.push("", "Contratos (eventos de administración)");
  if (facts.admin.length === 0) {
    const scanned = Object.entries(facts.adminScannedTo).map(([net, block]) => `${NET_LABEL[net as keyof typeof NET_LABEL]} hasta el bloque ${block}`);
    lines.push(`  Sin eventos nuevos${scanned.length ? ` (${scanned.join(", ")})` : ""}`);
  }
  for (const a of facts.admin) lines.push(`  ⚠️ ${a.contract} · ${a.event} · bloque ${a.block} · ${a.tx}`);

  lines.push("", "CI (main)");
  if (facts.ci) {
    const ok = facts.ci.status !== "completed" || facts.ci.conclusion === "success";
    lines.push(`  ${ok ? "✅" : "⚠️"} ${facts.ci.status === "completed" ? facts.ci.conclusion : facts.ci.status} · ${facts.ci.title} (${facts.ci.sha.slice(0, 7)})`);
  } else lines.push("  (sin datos)");

  return lines.join("\n");
}

/** Mensaje corto para Telegram cuando algo cambió. */
export function formatNotification(plan: NotifyPlan, at: Date): string {
  const lines = [`Sekisho · ${stamp(at)}`];
  if (plan.opened.length) lines.push("", "🔴 Nuevas", ...plan.opened.map((a) => `• ${a.text}`));
  if (plan.ongoing.length) lines.push("", "🟠 Siguen abiertas", ...plan.ongoing.map((a) => `• ${a.text}`));
  if (plan.resolved.length) lines.push("", "🟢 Resueltas", ...plan.resolved.map((t) => `• ${t}`));
  return lines.join("\n");
}
