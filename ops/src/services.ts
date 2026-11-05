import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402Client } from "@x402/core/client";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { parseUnits } from "viem";

/** Una entrada de apps/web/public/services.json. */
export interface Service {
  id: string;
  name: string;
  description: string;
  kind: "http" | "mcp";
  method?: string;
  url: string;
  tool?: string;
  network: string;
  asset: string;
  priceUsdc: string;
  payTo: string;
  seller: string;
  provider: { name: string; url: string };
  docs: string;
  tags: string[];
}

export interface Directory {
  version: number;
  updated: string;
  services: Service[];
}

interface Accept {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Valida la forma del directorio. Devuelve la lista de problemas (vacía si está bien). */
export function validateDirectory(dir: Directory): string[] {
  const problems: string[] = [];
  if (dir.version !== 1) problems.push("version debe ser 1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dir.updated ?? "")) problems.push("updated debe ser YYYY-MM-DD");
  const ids = new Set<string>();
  for (const s of dir.services ?? []) {
    const p = (m: string) => problems.push(`${s.id ?? "(sin id)"}: ${m}`);
    if (!/^[a-z0-9-]+$/.test(s.id ?? "")) p("id debe ser minúsculas, números y guiones");
    if (ids.has(s.id)) p("id repetido");
    ids.add(s.id);
    if (!s.name || !s.description) p("faltan name o description");
    if (s.kind !== "http" && s.kind !== "mcp") p('kind debe ser "http" o "mcp"');
    if (s.kind === "mcp" && !s.tool) p("un servicio MCP necesita tool");
    try {
      if (new URL(s.url).protocol !== "https:") p("url debe ser https");
    } catch {
      p("url inválida");
    }
    if (!/^eip155:(43114|43113)$/.test(s.network ?? "")) p("network debe ser eip155:43114 o eip155:43113");
    for (const field of ["asset", "payTo", "seller"] as const) if (!ADDRESS.test(s[field] ?? "")) p(`${field} no es una dirección`);
    if (!/^\d+(\.\d{1,6})?$/.test(s.priceUsdc ?? "") || Number(s.priceUsdc) <= 0) p("priceUsdc inválido");
  }
  return problems;
}

/** Compara lo que pide el servidor (402) con lo que promete el directorio. */
export function checkAccepts(service: Service, accepts: Accept[] | undefined): string[] {
  if (!accepts?.length) return ["el servidor no pidió pago (sin accepts)"];
  const match = accepts.find((a) => a.network === service.network);
  if (!match) return [`el servidor no acepta pago en ${service.network}`];
  const problems: string[] = [];
  if (match.scheme !== "exact") problems.push(`scheme ${match.scheme}, se esperaba exact`);
  if (match.asset?.toLowerCase() !== service.asset.toLowerCase()) problems.push(`asset ${match.asset} ≠ ${service.asset}`);
  if (match.payTo?.toLowerCase() !== service.payTo.toLowerCase()) problems.push(`payTo ${match.payTo} ≠ ${service.payTo}`);
  const expected = parseUnits(service.priceUsdc, 6).toString();
  if (match.amount !== expected) problems.push(`precio ${match.amount} atómico ≠ ${expected} (${service.priceUsdc} USDC)`);
  return problems;
}

/** Pide el servicio SIN pagar y revisa el 402. Nunca firma nada. */
export async function probeService(service: Service): Promise<string[]> {
  if (service.kind === "http") {
    const res = await fetch(service.url, {
      method: service.method ?? "GET",
      headers: { "user-agent": "sekisho-ops" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 402) return [`HTTP ${res.status}, se esperaba 402`];
    const header = res.headers.get("payment-required");
    if (!header) return ["402 sin header PAYMENT-REQUIRED"];
    const required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { x402Version?: number; accepts?: Accept[] };
    const problems = required.x402Version === 2 ? [] : [`x402Version ${required.x402Version}, se esperaba 2`];
    return [...problems, ...checkAccepts(service, required.accepts)];
  }

  // MCP: la tool debe existir y responder "pago requerido" con lo prometido.
  // Un x402Client sin esquemas no puede firmar: imposible pagar por accidente.
  const client = wrapMCPClientWithPayment(new Client({ name: "sekisho-ops", version: "1" }), new x402Client(), { autoPayment: false });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const { tools } = await client.listTools();
    if (!tools.some((t) => t.name === service.tool)) return [`la tool ${service.tool} no existe en ${service.url}`];
    const required = await client.getToolPaymentRequirements(service.tool!, {});
    if (!required) return [`la tool ${service.tool} respondió sin cobrar`];
    return checkAccepts(service, required.accepts as Accept[]);
  } finally {
    await client.close().catch(() => {});
  }
}
