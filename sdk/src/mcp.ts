import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  createPaymentWrapper,
  wrapMCPClientWithPayment,
  x402ResourceServer,
} from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { x402Facilitator } from "@x402/core/facilitator";
import type { Address } from "viem";
import type { SekishoClient } from "./client.js";
import { createPaymentOption } from "./x402.js";
import { createSekishoPaymentClient, type SekishoAgentOptions } from "./agent.js";
import { toFacilitatorClient } from "./facilitator.js";
import { SDK_VERSION } from "./version.js";
import type { SekishoDistributor } from "./distributor.js";

// ─────────────────────────── Servidor ───────────────────────────

export interface SekishoMcpPaywallOptions {
  sekisho: SekishoClient;
  /** Facilitator que verifica y liquida (por ejemplo, createSekishoFacilitator). */
  facilitator: x402Facilitator;
  /** Wallet del vendedor (dueño del vault). */
  merchant: Address;
  /** Precio por llamada en USD, por ejemplo "0.01". */
  price: string;
  /** Se ejecuta después de cada pago liquidado. */
  onSettled?: (info: { toolName: string; transaction: string }) => void | Promise<void>;
  /**
   * Repartidor (createSekishoDistributor) que se avisa en cada pago liquidado:
   * registra el pago y revisa la política sin retrasar la respuesta de la tool.
   */
  distributor?: SekishoDistributor;
}

export type SekishoMcpPaywall = ReturnType<typeof createPaymentWrapper>;

/**
 * Envoltura para tools MCP de pago. El payTo es el SplitVault del vendedor.
 */
export async function createSekishoMcpPaywall(
  options: SekishoMcpPaywallOptions
): Promise<SekishoMcpPaywall> {
  const option = await createPaymentOption(options.sekisho, {
    merchant: options.merchant,
    price: options.price,
  });

  const resourceServer = new x402ResourceServer(toFacilitatorClient(options.facilitator));
  resourceServer.register(option.network, new ExactEvmScheme());
  await resourceServer.initialize();

  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: option.scheme,
    network: option.network,
    payTo: option.payTo,
    price: option.price,
  });

  return createPaymentWrapper(resourceServer, {
    accepts,
    hooks: {
      onAfterSettlement: async ({ toolName, settlement }) => {
        if (options.distributor) {
          options.distributor.notePayment(options.merchant);
          void options.distributor.check().catch(() => {});
        }
        await options.onSettled?.({ toolName, transaction: settlement.transaction });
      },
    },
  });
}

// ─────────────────────────── Cliente ───────────────────────────

export interface SekishoMcpClientOptions extends SekishoAgentOptions {
  name?: string;
}

export type SekishoMcpClient = ReturnType<typeof wrapMCPClientWithPayment>;

/** Cliente MCP para agentes que paga tools automáticamente. */
export function createSekishoMcpClient(options: SekishoMcpClientOptions): SekishoMcpClient {
  const mcpClient = new Client({ name: options.name ?? "sekisho-agent", version: SDK_VERSION });
  return wrapMCPClientWithPayment(mcpClient, createSekishoPaymentClient(options), {
    autoPayment: true,
  });
}