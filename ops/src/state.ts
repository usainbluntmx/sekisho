import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Alert, Net } from "./types.js";

/** Lo que se recuerda entre chequeos: alertas abiertas y hasta qué bloque se revisaron eventos. */
export interface State {
  alerts: Record<string, { text: string; since: string; lastSent: string }>;
  adminScannedTo: Partial<Record<Net, string>>;
}

export const emptyState = (): State => ({ alerts: {}, adminScannedTo: {} });

export function loadState(path: string): State {
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
    return { alerts: parsed.alerts ?? {}, adminScannedTo: parsed.adminScannedTo ?? {} };
  } catch {
    return emptyState(); // un estado dañado no debe tumbar el monitor
  }
}

export function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export interface NotifyPlan {
  opened: Alert[];
  ongoing: Alert[]; // siguen abiertas y toca recordarlas
  resolved: string[]; // textos de las que se cerraron
  shouldSend: boolean;
  next: State;
}

/**
 * Prefijos de alertas que esta corrida no pudo evaluar porque su fuente falló
 * (SEKISHO-BUG-013): si la RPC de una red no responde, sus alertas de saldo y reparto no
 * están "resueltas", simplemente no se vieron.
 */
export function blindedPrefixes(errors: { key: string }[]): string[] {
  const prefixes: string[] = [];
  for (const { key } of errors) {
    const [source, network, address] = key.split(":");
    const addr = address?.toLowerCase();
    if (source === "metrics") prefixes.push("metrics:");
    else if (source === "rpc" && network) prefixes.push(`avax:${network}:`, `split:${network}:`, `stale:${network}:`);
    else if (source === "balance" && network && addr) prefixes.push(`avax:${network}:${addr}`);
    else if (source === "vault" && network && addr) prefixes.push(`split:${network}:${addr}`, `stale:${network}:${addr}`);
    else if (source === "services") prefixes.push("service:");
    else if (source === "ci") prefixes.push("ci:");
  }
  return prefixes;
}

/**
 * Decide qué avisar: alertas nuevas y resueltas siempre; las que siguen abiertas,
 * solo cada `remindEveryHours` para no llenar el chat. Una alerta abierta cuya fuente
 * falló en esta corrida (`blind`) se conserva tal cual: no se da por resuelta.
 */
export function planNotification(prev: State, alerts: Alert[], now: Date, remindEveryHours: number, blind: string[] = []): NotifyPlan {
  const iso = now.toISOString();
  const next: State = { alerts: {}, adminScannedTo: { ...prev.adminScannedTo } };
  const opened: Alert[] = [];
  const ongoing: Alert[] = [];

  for (const alert of alerts) {
    const before = prev.alerts[alert.key];
    if (!before) {
      opened.push(alert);
      next.alerts[alert.key] = { text: alert.text, since: iso, lastSent: iso };
      continue;
    }
    const due = now.getTime() - new Date(before.lastSent).getTime() >= remindEveryHours * 3_600_000;
    if (due) ongoing.push(alert);
    next.alerts[alert.key] = { text: alert.text, since: before.since, lastSent: due ? iso : before.lastSent };
  }

  const current = new Set(alerts.map((a) => a.key));
  const unseen = (key: string) => blind.some((prefix) => key.startsWith(prefix));
  for (const [key, value] of Object.entries(prev.alerts)) {
    if (!current.has(key) && unseen(key)) next.alerts[key] = value; // sin datos: sigue abierta
  }
  const resolved = Object.entries(prev.alerts)
    // los eventos de administración son avisos únicos: no se "resuelven"
    .filter(([key]) => !current.has(key) && !key.startsWith("admin:") && !unseen(key))
    .map(([, value]) => value.text);

  return { opened, ongoing, resolved, shouldSend: opened.length + ongoing.length + resolved.length > 0, next };
}
