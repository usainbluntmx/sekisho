#!/usr/bin/env node
/**
 * Puerta de seguridad de dependencias para CI.
 *
 * Igual que `npm audit --omit=dev --audit-level=high`, pero admite excepciones puntuales en
 * `audit-allowlist.json` (junto al package.json): cada una con su aviso (GHSA), el motivo y una
 * fecha de vencimiento. Al vencer, la excepción deja de valer y el CI vuelve a fallar, así que
 * nunca queda olvidada. Cualquier otro aviso alto o crítico falla.
 *
 * Uso (desde la carpeta del paquete): node ../../scripts/audit-gate.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const LEVELS = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const MIN = LEVELS.high;

let report;
try {
  report = JSON.parse(execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
} catch (error) {
  // npm audit sale con código ≠ 0 cuando hay avisos: el JSON viene en stdout igual
  if (!error.stdout) throw error;
  report = JSON.parse(error.stdout);
}

const today = new Date().toISOString().slice(0, 10);
const allowlist = existsSync("audit-allowlist.json") ? JSON.parse(readFileSync("audit-allowlist.json", "utf8")) : [];
const active = new Map();
for (const entry of allowlist) {
  if (!/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/.test(entry.id ?? "") || !entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? "")) {
    console.error(`❌ Excepción mal formada en audit-allowlist.json: ${JSON.stringify(entry)}`);
    process.exit(1);
  }
  if (entry.expires < today) console.log(`⚠️  La excepción ${entry.id} venció el ${entry.expires}: ya no vale, revísala.`);
  else active.set(entry.id, entry);
}

// Avisos propios (no "por dependencia"), con su id GHSA
const advisories = new Map();
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via !== "object") continue;
    const id = (via.url ?? "").split("/").pop();
    advisories.set(id, { id, name, severity: via.severity, title: via.title, range: via.range });
  }
}

let blocking = 0;
for (const a of advisories.values()) {
  if ((LEVELS[a.severity] ?? 0) < MIN) continue;
  const allowed = active.get(a.id);
  if (allowed) {
    console.log(`↷ ${a.id} (${a.name} ${a.range}, ${a.severity}) permitido hasta ${allowed.expires}: ${allowed.reason}`);
  } else {
    console.log(`❌ ${a.id} (${a.name} ${a.range}, ${a.severity}): ${a.title}`);
    blocking++;
  }
}
for (const id of active.keys()) {
  if (!advisories.has(id)) console.log(`ℹ️  La excepción ${id} ya no hace falta (el aviso desapareció): bórrala de audit-allowlist.json.`);
}

console.log(blocking ? `\n❌ ${blocking} aviso(s) alto(s) o crítico(s) sin resolver` : "\n✅ Sin avisos altos o críticos sin resolver");
process.exit(blocking ? 1 : 0);
