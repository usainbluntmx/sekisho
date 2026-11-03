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
 * Decide qué avisar: alertas nuevas y resueltas siempre; las que siguen abiertas,
 * solo cada `remindEveryHours` para no llenar el chat.
 */
export function planNotification(prev: State, alerts: Alert[], now: Date, remindEveryHours: number): NotifyPlan {
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
  const resolved = Object.entries(prev.alerts)
    // los eventos de administración son avisos únicos: no se "resuelven"
    .filter(([key]) => !current.has(key) && !key.startsWith("admin:"))
    .map(([, value]) => value.text);

  return { opened, ongoing, resolved, shouldSend: opened.length + ongoing.length + resolved.length > 0, next };
}
