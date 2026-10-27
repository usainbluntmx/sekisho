import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  NETWORKS,
  SDK_VERSION,
  createPaymentOption,
  createSekishoClient,
  createSekishoFacilitator,
  createSekishoFetch,
  toFacilitatorClient,
  type SekishoClient,
} from "../src/index.js";

const FUJI = NETWORKS.avalancheFuji;
const VAULT = "0x6827B96001EE85eF16fa7a85c4A7daf62CD4AC2f" as const;
const OTHER_TOKEN = "0x0000000000000000000000000000000000000bad" as const;
const URL_PREMIUM = "http://test.local/premium";

// Cliente simulado: sin red, devuelve siempre el mismo vault
const mockClient = {
  network: "avalancheFuji",
  config: FUJI,
  getPayTo: async () => VAULT,
} as unknown as SekishoClient;

/** Respuesta 402 con el mismo formato que envía un servidor x402 v2 real. */
function paymentRequired(amount: string, asset: string = FUJI.usdc): Response {
  const body = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: URL_PREMIUM, description: "test", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:43113",
        amount,
        asset,
        payTo: VAULT,
        maxTimeoutSeconds: 300,
        extra: { ...FUJI.usdcEip712 },
      },
    ],
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(body)).toString("base64"),
    },
  });
}

/** Servidor falso: 402 sin pago y 200 con pago. Registra cada firma recibida. */
function fakeServer(amount: string, asset?: string): { signatures: string[] } {
  const signatures: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Request(input, init).headers;
      const signature = headers.get("payment-signature") ?? headers.get("x-payment");
      if (signature) {
        signatures.push(signature);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return paymentRequired(amount, asset);
    })
  );
  return { signatures };
}

/** Intenta pagar y devuelve el status, o "error" si el cliente se negó. */
async function attempt(pay: typeof fetch): Promise<number | "error"> {
  try {
    return (await pay(URL_PREMIUM)).status;
  } catch {
    return "error";
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("configuración de redes", () => {
  it("Fuji tiene chain id, USDC, dominio EIP-712 y factory", () => {
    expect(FUJI.chain.id).toBe(43113);
    expect(FUJI.usdc).toBe("0x5425890298aed601595a70AB815c96711a31Bc65");
    expect(FUJI.usdcEip712).toEqual({ name: "USD Coin", version: "2" });
    expect(FUJI.factory).toBeDefined();
  });

  it("escribir sin account lanza un error claro (sin tocar la red)", async () => {
    await expect(createSekishoClient().createVault(VAULT)).rejects.toThrow(/requiere `account`/);
  });
});

describe("createPaymentOption", () => {
  it("construye la opción x402 con payTo = vault, monto atómico y dominio EIP-712", async () => {
    const option = await createPaymentOption(mockClient, { merchant: VAULT, price: "0.01" });
    expect(option).toEqual({
      scheme: "exact",
      network: "eip155:43113",
      payTo: VAULT,
      price: { amount: "10000", asset: FUJI.usdc, extra: { name: "USD Coin", version: "2" } },
    });
  });

  it("convierte la unidad mínima de USDC (6 decimales)", async () => {
    const option = await createPaymentOption(mockClient, { merchant: VAULT, price: "0.000001" });
    expect(option.price.amount).toBe("1");
  });

  it("rechaza un precio de 0", async () => {
    await expect(createPaymentOption(mockClient, { merchant: VAULT, price: "0" })).rejects.toThrow(/mayor a 0/);
  });
});

describe("createSekishoFetch (topes de gasto del agente)", () => {
  const account = privateKeyToAccount(generatePrivateKey());

  it("paga y firma cuando el monto está dentro del tope", async () => {
    const { signatures } = fakeServer("10000"); // 0.01 USDC
    const { fetch: pay } = createSekishoFetch({ account, maxPerPayment: "0.05" });
    expect(await attempt(pay)).toBe(200);
    expect(signatures).toHaveLength(1);
  });

  it("NO firma si el monto excede el tope", async () => {
    const { signatures } = fakeServer("100000"); // 0.10 USDC
    const { fetch: pay } = createSekishoFetch({ account, maxPerPayment: "0.05" });
    expect(await attempt(pay)).not.toBe(200);
    expect(signatures).toHaveLength(0);
  });

  it("NO firma si el token no es el USDC de la red", async () => {
    const { signatures } = fakeServer("10000", OTHER_TOKEN);
    const { fetch: pay } = createSekishoFetch({ account, maxPerPayment: "0.05" });
    expect(await attempt(pay)).not.toBe(200);
    expect(signatures).toHaveLength(0);
  });
});

describe("facilitator propio", () => {
  const account = privateKeyToAccount(generatePrivateKey());

  it("anuncia el esquema exact en Fuji", async () => {
    const facilitator = createSekishoFacilitator({ account });
    const supported = await facilitator.getSupported();
    expect(supported.kinds.some((k) => k.scheme === "exact" && k.network === "eip155:43113")).toBe(true);
  });

  it("toFacilitatorClient expone verify, settle y el mismo getSupported", async () => {
    const facilitator = createSekishoFacilitator({ account });
    const client = toFacilitatorClient(facilitator);
    expect(typeof client.verify).toBe("function");
    expect(typeof client.settle).toBe("function");
    expect(await client.getSupported()).toEqual(await facilitator.getSupported());
  });
});

describe("metadatos", () => {
  it("SDK_VERSION sale del package.json", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});