/**
 * Revisión previa a mainnet (solo lectura: no firma ni manda transacciones).
 *
 * Se corre ANTES de cambiar NETWORK=avalanche, con la misma base y las mismas variables de
 * producción, y dice qué falta: red, contratos, USDC, gas del operador, tiendas y variables.
 */
import { formatEther, getAddress, isAddress, type Address } from "viem";

export type Level = "ok" | "warn" | "fail";
export interface CheckLine {
  level: Level;
  section: string;
  text: string;
}

export interface MainnetFacts {
  chainId: number;
  config: { factory: Address; usdc: Address; treasury: Address; feeBps: number; feeChange: { feeBps: number; effectiveAt: Date } | null };
  usdc: { symbol: string; decimals: number };
  operator: Address;
  operatorWei: bigint;
  /** Tiendas publicadas con su wallet, si está firmada y el payTo (o el error al pedirlo). */
  stores: {
    id: string;
    name: string;
    merchant: string;
    verified: boolean;
    owner: string | null;
    /** La tienda demo (Café Kanjō): se queda en Fuji y se oculta sola al arrancar en mainnet. */
    demo?: boolean;
    payTo: { ok: true; vault: Address } | { ok: false; error: string };
  }[];
  env: Record<string, string | undefined>;
}

export const MAINNET_CHAIN_ID = 43114;
export const EXPECTED_TREASURY = "0xbABB7B7C35438B2Ab646da3C820859062ACEA3Dc";
export const MIN_OPERATOR_AVAX = 0.2;

export function evaluateMainnet(f: MainnetFacts): CheckLine[] {
  const lines: CheckLine[] = [];
  const add = (level: Level, section: string, text: string) => lines.push({ level, section, text });

  // Red
  add(f.chainId === MAINNET_CHAIN_ID ? "ok" : "fail", "Red", `chainId ${f.chainId}${f.chainId === MAINNET_CHAIN_ID ? " (Avalanche C-Chain)" : ` — se esperaba ${MAINNET_CHAIN_ID}`}`);
  add(f.env.AVALANCHE_RPC_URL ? "ok" : "warn", "Red", f.env.AVALANCHE_RPC_URL ? "RPC propia configurada" : "Sin RPC propia: se usarán las públicas (en Fuji tuvieron timeouts). Recomendado: AVALANCHE_RPC_URL");

  // Contratos de Sekisho
  const treasury = f.env.EXPECTED_TREASURY ?? EXPECTED_TREASURY;
  add(
    getAddress(f.config.treasury) === getAddress(treasury) ? "ok" : "fail",
    "Sekisho",
    `Tesorería ${f.config.treasury}${getAddress(f.config.treasury) === getAddress(treasury) ? " (la Safe 2 de 3)" : ` — se esperaba ${treasury}`}`
  );
  add("ok", "Sekisho", `Factory ${f.config.factory} · comisión ${(f.config.feeBps / 100).toFixed(2)} %`);
  if (f.config.feeChange) {
    add("warn", "Sekisho", `Cambio de comisión programado: ${(f.config.feeChange.feeBps / 100).toFixed(2)} % desde ${f.config.feeChange.effectiveAt.toISOString()}`);
  }
  const usdcOk = f.usdc.symbol === "USDC" && f.usdc.decimals === 6;
  add(usdcOk ? "ok" : "fail", "Sekisho", `Token de cobro ${f.config.usdc}: ${f.usdc.symbol}, ${f.usdc.decimals} decimales${usdcOk ? "" : " — se esperaba USDC con 6"}`);

  // Operador (liquida los pagos y reparte: paga el gas)
  const avax = Number(formatEther(f.operatorWei));
  add(
    avax >= MIN_OPERATOR_AVAX ? "ok" : "fail",
    "Operador",
    `${f.operator}: ${avax.toFixed(4)} AVAX${avax >= MIN_OPERATOR_AVAX ? "" : ` — necesita al menos ${MIN_OPERATOR_AVAX} AVAX en mainnet antes de cobrar`}`
  );

  // Tiendas publicadas (la demo no cuenta: se queda en Fuji)
  for (const s of f.stores.filter((x) => x.demo)) {
    add("ok", "Tiendas", `${s.name} (${s.id}) es la demo de Fuji: al arrancar en mainnet se oculta sola`);
  }
  const real = f.stores.filter((x) => !x.demo);
  if (real.length === 0) add("warn", "Tiendas", "Sin tiendas reales publicadas: en mainnet nadie podrá comprar hasta que apruebes la primera alta por chat");
  for (const s of real) {
    const wallet = isAddress(s.merchant, { strict: false });
    if (!wallet) {
      add("fail", "Tiendas", `${s.name} (${s.id}): wallet inválida`);
      continue;
    }
    if (!s.payTo.ok) add("fail", "Tiendas", `${s.name} (${s.id}): no se pudo obtener su vault — ${s.payTo.error}`);
    else {
      const signature = s.verified ? " · wallet firmada" : s.owner ? " · wallet SIN firmar (el dueño puede firmarla con /wallet)" : " · wallet SIN firmar y sin dueño en el chat (no se puede firmar)";
      add(s.verified ? "ok" : "warn", "Tiendas", `${s.name} (${s.id}) → vault ${s.payTo.vault}${signature}`);
    }
    if (!s.owner && !f.env.MERCHANT_WA_ID) add("warn", "Tiendas", `${s.name}: no tiene dueño ni MERCHANT_WA_ID, así que sus avisos de pedido pagado no le llegan a nadie`);
  }

  // Variables
  const base = f.env.PUBLIC_BASE_URL ?? "";
  add(base.startsWith("https://") ? "ok" : "fail", "Variables", `PUBLIC_BASE_URL ${base || "(vacía)"}${base.startsWith("https://") ? "" : " — debe ser https"}`);
  add(f.env.FX_MXN_PER_USDC ? "ok" : "warn", "Variables", f.env.FX_MXN_PER_USDC ? `FX_MXN_PER_USDC ${f.env.FX_MXN_PER_USDC} (revísalo contra el FIX de Banxico)` : "FX_MXN_PER_USDC vacío: el alta de comerciantes no puede convertir precios en pesos");
  add(f.env.KANJO_ADMIN_ID ? "ok" : "warn", "Variables", f.env.KANJO_ADMIN_ID ? "KANJO_ADMIN_ID configurado" : "KANJO_ADMIN_ID vacío: nadie puede aprobar tiendas ni cambios de wallet");
  if (f.env.NETWORK === "avalanche") add("ok", "Variables", "NETWORK=avalanche (ya en mainnet)");
  else add("ok", "Variables", `NETWORK=${f.env.NETWORK || "avalancheFuji"} → cuando todo esté en verde, cámbiala a avalanche y redepliega`);

  return lines;
}

const ICON: Record<Level, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };

export function formatReport(lines: CheckLine[]): string {
  const out: string[] = ["Kanjō · revisión previa a mainnet (solo lectura)"];
  let section = "";
  for (const l of lines) {
    if (l.section !== section) {
      section = l.section;
      out.push("", section);
    }
    out.push(`  ${ICON[l.level]} ${l.text}`);
  }
  const fails = lines.filter((l) => l.level === "fail").length;
  const warns = lines.filter((l) => l.level === "warn").length;
  out.push("", fails ? `❌ ${fails} pendiente(s) que impiden ir a mainnet · ${warns} aviso(s)` : `✅ Lista para mainnet · ${warns} aviso(s)`);
  return out.join("\n");
}
