import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SpendEntry {
  at: string; // ISO
  network: string; // CAIP-2
  amount: string; // USDC atómico
  tool: string;
  tx?: string;
}

const DAY_MS = 86_400_000;

/**
 * Registro de gasto en disco: el tope diario sobrevive a reinicios del proxy
 * (los clientes MCP lo arrancan de nuevo en cada sesión). Guarda solo los últimos 7 días.
 */
export class SpendLedger {
  private entries: SpendEntry[];

  constructor(private readonly file: string) {
    this.entries = SpendLedger.read(file);
  }

  private static read(file: string): SpendEntry[] {
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: SpendEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      // Un registro ilegible NO se trata como "cero gastado": se rechaza para no saltarse el tope
      throw new Error(`No se pudo leer el registro de gasto ${file}; revísalo o bórralo si sabes que está vacío`);
    }
  }

  /** Lo gastado en las últimas 24 h en esa red. Relee el archivo: otra sesión pudo haber pagado. */
  spentLast24h(network: string, now = Date.now()): bigint {
    this.entries = SpendLedger.read(this.file);
    return this.entries
      .filter((e) => e.network === network && now - Date.parse(e.at) < DAY_MS)
      .reduce((sum, e) => sum + BigInt(e.amount), 0n);
  }

  /** Registra un pago (se llama ANTES de firmar: un pago firmado cuenta aunque el servidor falle). */
  record(entry: SpendEntry, now = Date.now()): void {
    this.entries = SpendLedger.read(this.file)
      .filter((e) => now - Date.parse(e.at) < 7 * DAY_MS)
      .concat(entry);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ entries: this.entries }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Completa el hash del último pago de esa tool cuando llega la liquidación. */
  attachTx(tool: string, tx: string): void {
    const last = [...this.entries].reverse().find((e) => e.tool === tool && !e.tx);
    if (!last) return;
    last.tx = tx;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ entries: this.entries }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
