import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface SpendEntry {
  at: string; // ISO
  network: string; // CAIP-2
  amount: string; // USDC atómico
  tool: string;
  tx?: string;
}

export type Reservation = { ok: true; spent: bigint } | { ok: false; spent: bigint };

export interface LedgerOptions {
  /** Cuánto esperar a que otro proceso suelte el candado antes de rechazar (ms). */
  lockTimeoutMs?: number;
  /** Un candado más viejo que esto se considera abandonado (proceso caído) y se quita (ms). */
  staleLockMs?: number;
}

const DAY_MS = 86_400_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number) => Atomics.wait(sleeper, 0, 0, ms);

/**
 * Registro de gasto en disco: el tope diario sobrevive a reinicios del proxy y se comparte entre
 * varios proxies abiertos a la vez (p. ej. OpenCode y Claude Code con la misma wallet).
 *
 * Toda lectura-revisión-escritura ocurre con un candado de archivo (`<archivo>.lock`, creado en
 * exclusiva), así dos procesos nunca revisan el tope al mismo tiempo ni se pisan al escribir.
 * Guarda solo los últimos 7 días.
 */
export class SpendLedger {
  private readonly lockFile: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(private readonly file: string, options: LedgerOptions = {}) {
    this.lockFile = `${file}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    SpendLedger.read(file); // un registro ilegible falla desde el arranque
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

  private write(entries: SpendEntry[]): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // Archivo temporal único por escritura: dos procesos nunca comparten el mismo .tmp
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify({ entries }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Ejecuta `fn` con el candado tomado. Si no se consigue a tiempo, lanza (y no se paga). */
  private withLock<T>(fn: () => T): T {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockTimeoutMs;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(this.lockFile, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(this.lockFile).mtimeMs > this.staleLockMs) {
            unlinkSync(this.lockFile); // lo dejó un proceso que murió con el candado tomado
            continue;
          }
        } catch {
          continue; // se soltó entre el intento y la revisión
        }
        if (Date.now() > deadline) {
          throw new Error(`El registro de gasto ${this.file} está ocupado por otro proceso; no se pagó. Intenta de nuevo.`);
        }
        sleepSync(10 + Math.floor(Math.random() * 20));
      }
    }
    try {
      writeFileSync(fd, String(process.pid));
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(this.lockFile);
      } catch {
        // ya no estaba (lo quitó otro proceso por viejo): no hay nada que soltar
      }
    }
  }

  private static spent(entries: SpendEntry[], network: string, now: number): bigint {
    return entries
      .filter((e) => e.network === network && now - Date.parse(e.at) < DAY_MS)
      .reduce((sum, e) => sum + BigInt(e.amount), 0n);
  }

  /** Lo gastado en las últimas 24 h en esa red (siempre desde el archivo: otra sesión pudo pagar). */
  spentLast24h(network: string, now = Date.now()): bigint {
    return SpendLedger.spent(SpendLedger.read(this.file), network, now);
  }

  /**
   * Revisa el tope y registra el pago en un solo paso, con el candado tomado. Se llama ANTES de
   * firmar: un pago firmado cuenta aunque el servidor falle.
   */
  reserve(entry: SpendEntry, maxPerDay: bigint, now = Date.now()): Reservation {
    return this.withLock(() => {
      const entries = SpendLedger.read(this.file);
      const spent = SpendLedger.spent(entries, entry.network, now);
      if (spent + BigInt(entry.amount) > maxPerDay) return { ok: false as const, spent };
      this.write(entries.filter((e) => now - Date.parse(e.at) < 7 * DAY_MS).concat(entry));
      return { ok: true as const, spent };
    });
  }

  /** Registra un pago sin revisar tope (con candado). */
  record(entry: SpendEntry, now = Date.now()): void {
    this.withLock(() => {
      const entries = SpendLedger.read(this.file);
      this.write(entries.filter((e) => now - Date.parse(e.at) < 7 * DAY_MS).concat(entry));
    });
  }

  /** Completa el hash del último pago de esa tool cuando llega la liquidación (relee: no pisa a otros). */
  attachTx(tool: string, tx: string): void {
    this.withLock(() => {
      const entries = SpendLedger.read(this.file);
      const last = [...entries].reverse().find((e) => e.tool === tool && !e.tx);
      if (!last) return;
      last.tx = tx;
      this.write(entries);
    });
  }
}
