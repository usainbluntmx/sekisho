import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { NETWORKS, createSekishoPaymentClient, type SekishoNetwork } from "@zero-two-labs/sekisho";
import { formatUnits, type LocalAccount } from "viem";
import type { SpendLedger } from "./ledger.js";

export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
export const WALLET_TOOL = "sekisho_wallet";

export interface ProxyOptions {
  url: URL;
  account: LocalAccount;
  network: SekishoNetwork;
  maxPerCall: bigint;
  maxPerDay: bigint;
  ledger: SpendLedger;
  log?: (message: string) => void;
  /** Para pruebas: transporte hacia el MCP remoto. */
  remoteTransport?: Transport;
}

const usdc = (atomic: bigint) => formatUnits(atomic, 6);

/**
 * Servidor MCP local que reexpone las tools de un MCP remoto y paga las de pago con x402.
 * Topes: por llamada (lo aplica también el cliente x402) y por 24 h (registro en disco).
 */
export async function createProxy(options: ProxyOptions) {
  const log = options.log ?? ((m: string) => process.stderr.write(`${m}\n`)); // stdout es del protocolo MCP
  const caip2 = `eip155:${NETWORKS[options.network].chain.id}`;
  const { account, ledger, maxPerCall, maxPerDay } = options;

  // Motivo del último rechazo, para devolverle al agente un error claro
  let denial: string | undefined;
  let currentTool = "";
  // Precio aprendido de cada tool (del primer 402). Se muestra en su descripción para que el agente lo sepa
  const prices = new Map<string, bigint>();
  let pricesChanged = false;

  const payment = createSekishoPaymentClient({ account, network: options.network, maxPerPayment: usdc(maxPerCall) });
  const remote = wrapMCPClientWithPayment(new Client({ name: "sekisho-mcp", version: VERSION }), payment, {
    autoPayment: true,
    onPaymentRequested: ({ toolName, paymentRequired }) => {
      const option = paymentRequired.accepts.find((a) => a.network === caip2);
      if (!option) {
        denial = `La tool "${toolName}" no acepta pago en ${caip2} (${options.network}).`;
        return false;
      }
      const amount = BigInt(option.amount);
      if (prices.get(toolName) !== amount) {
        prices.set(toolName, amount);
        pricesChanged = true;
      }
      if (amount > maxPerCall) {
        denial = `La tool "${toolName}" cuesta ${usdc(amount)} USDC, más que tu tope por llamada (${usdc(maxPerCall)}). No se pagó.`;
        return false;
      }
      // Revisar el tope y registrar el pago es un solo paso con candado: otro proxy con la misma
      // wallet no puede colarse entre los dos
      let reservation;
      try {
        reservation = ledger.reserve({ at: new Date().toISOString(), network: caip2, amount: amount.toString(), tool: toolName }, maxPerDay);
      } catch (error) {
        denial = (error as Error).message;
        return false;
      }
      const { spent } = reservation;
      if (!reservation.ok) {
        denial = `Tope de 24 h alcanzado: llevas ${usdc(spent)} de ${usdc(maxPerDay)} USDC; esta llamada cuesta ${usdc(amount)}. No se pagó.`;
        return false;
      }
      log(`[sekisho-mcp] Pagando ${usdc(amount)} USDC por "${toolName}" (24 h: ${usdc(spent + amount)} de ${usdc(maxPerDay)})`);
      return true;
    },
  });

  await remote.connect(options.remoteTransport ?? new StreamableHTTPClientTransport(options.url));

  const walletTool: Tool = {
    name: WALLET_TOOL,
    description:
      "Free. Shows the Sekisho payer wallet used to pay x402 tools: address, network, per-call and 24 h caps, and how much was spent in the last 24 h.",
    inputSchema: { type: "object", properties: {} },
  };

  const server = new Server({ name: "sekisho-mcp", version: VERSION }, { capabilities: { tools: { listChanged: true } } });

  const priceNote = (name: string) => {
    const price = prices.get(name);
    if (price === undefined) return `[Sekisho: if this tool is paid, it is charged automatically from the user's wallet, up to ${usdc(maxPerCall)} USDC per call]`;
    return price > maxPerCall
      ? `[Sekisho: costs ${usdc(price)} USDC per call, above the user's cap of ${usdc(maxPerCall)}: calls will be refused]`
      : `[Sekisho: costs ${usdc(price)} USDC per call, paid automatically from the user's wallet]`;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await remote.listTools();
    return {
      tools: [
        ...tools
          .filter((t) => t.name !== WALLET_TOOL)
          .map((t) => ({ ...t, description: `${t.description ?? ""} ${priceNote(t.name)}`.trim() })),
        walletTool,
      ],
    };
  });

  // Las llamadas se atienden de una en una: el tope diario se revisa y registra sin carreras
  let queue: Promise<unknown> = Promise.resolve();
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const run = async () => {
      const { name, arguments: args = {} } = request.params;
      if (name === WALLET_TOOL) {
        const spent = ledger.spentLast24h(caip2);
        const text = [
          `Payer: ${account.address}`,
          `Network: ${options.network} (${caip2})`,
          `Per-call cap: ${usdc(maxPerCall)} USDC`,
          `24 h cap: ${usdc(maxPerDay)} USDC · spent: ${usdc(spent)} · left: ${usdc(maxPerDay > spent ? maxPerDay - spent : 0n)}`,
          `Remote MCP: ${options.url.href}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      }

      denial = undefined;
      currentTool = name;
      try {
        const result = await remote.callTool(name, args as Record<string, unknown>);
        const content = [...result.content] as { type: string; text?: string }[];
        if (result.paymentMade) {
          const tx = result.paymentResponse?.transaction;
          if (tx) ledger.attachTx(currentTool, tx);
          content.push({ type: "text", text: `[sekisho] Paid with x402 on ${options.network}${tx ? ` · tx ${tx}` : ""}` });
        }
        return { content, isError: result.isError };
      } catch (error) {
        const text = denial ?? `Sekisho: no se pudo completar la llamada: ${(error as Error).message}`;
        log(`[sekisho-mcp] ${text}`);
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    };
    const withNotify = async () => {
      const result = await run();
      if (pricesChanged) {
        pricesChanged = false;
        await server.sendToolListChanged().catch(() => {}); // el cliente vuelve a pedir la lista con el precio
      }
      return result;
    };
    const next = queue.then(withNotify, withNotify);
    queue = next.catch(() => {});
    return next as Promise<any>;
  });

  return {
    server,
    remote,
    async close() {
      await server.close().catch(() => {});
      await remote.close().catch(() => {});
    },
  };
}
