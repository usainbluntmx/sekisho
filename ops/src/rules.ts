import { formatEther, formatUnits, parseUnits } from "viem";
import { NET_LABEL, type Alert, type Facts, type Watch } from "./types.js";

export const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
export const avax = (wei: bigint) => Number(formatEther(wei)).toFixed(4);
export const usdc = (atomic: bigint) => formatUnits(atomic, 6);

/** Reglas puras: de lo leído a la lista de alertas. Cada alerta tiene una clave estable para no repetirla. */
export function evaluate(facts: Facts, rules: Watch["rules"]): Alert[] {
  const alerts: Alert[] = [];
  const now = facts.at.getTime();

  for (const b of facts.balances) {
    if (b.wei < b.minWei) {
      alerts.push({
        key: `avax:${b.network}:${b.address.toLowerCase()}`,
        text:
          `AVAX bajo: ${b.label} (${NET_LABEL[b.network]}, ${short(b.address)}) tiene ${avax(b.wei)} AVAX, ` +
          `mínimo ${avax(b.minWei)}. Sin gas no se liquidan pagos ni se reparte.`,
      });
    }
  }

  for (const e of facts.endpoints) {
    if (!e.ok) {
      alerts.push({
        key: `down:${e.label}`,
        text: `${e.label} no responde bien: ${e.status ? `HTTP ${e.status}` : (e.error ?? "sin respuesta")} (${e.url})`,
      });
    }
  }

  const ageMin = parseUnits(rules.pendingAgeMinUsdc, 6);
  for (const v of facts.vaults) {
    const where = `${v.label} (${NET_LABEL[v.network]}, vault ${short(v.vault)})`;
    if (v.pending >= v.splitAt) {
      alerts.push({
        key: `split:${v.network}:${v.merchant.toLowerCase()}`,
        text: `Reparto atrasado: ${where} tiene ${usdc(v.pending)} USDC pendientes, arriba del umbral de ${usdc(v.splitAt)}. El repartidor debió repartir.`,
      });
    } else if (
      v.pending >= ageMin &&
      v.lastPaymentAt &&
      now - v.lastPaymentAt.getTime() > rules.pendingMaxHours * 3_600_000
    ) {
      alerts.push({
        key: `stale:${v.network}:${v.merchant.toLowerCase()}`,
        text: `Reparto atrasado: ${where} tiene ${usdc(v.pending)} USDC pendientes y su último pago fue hace más de ${rules.pendingMaxHours} h.`,
      });
    }
  }

  const m = facts.metrics;
  if (m && !m.syncing && m.syncedBlock !== null && m.chainHead !== null) {
    const lag = m.chainHead - m.syncedBlock;
    if (lag > BigInt(rules.metricsMaxLagBlocks)) {
      alerts.push({
        key: "metrics:lag",
        text: `Las métricas van ${lag} bloques atrás de la cadena: el indexador dejó de avanzar.`,
      });
    }
  }

  for (const a of facts.admin) {
    alerts.push({
      key: `admin:${a.tx}:${a.event}`,
      text: `Evento de administración en ${a.contract === "safe" ? "la Safe" : "la factory"} (${NET_LABEL[a.network]}): ${a.event}, bloque ${a.block}, tx ${a.tx}. Confirma que fuiste tú.`,
    });
  }

  if (facts.ci && facts.ci.status === "completed" && facts.ci.conclusion !== "success") {
    alerts.push({
      key: `ci:${facts.ci.id}`,
      text: `El CI de main terminó en "${facts.ci.conclusion}": ${facts.ci.title} (${facts.ci.sha.slice(0, 7)}) ${facts.ci.url}`,
    });
  }

  for (const e of facts.errors) alerts.push({ key: `error:${e.key}`, text: `No se pudo leer ${e.text}` });

  return alerts;
}
