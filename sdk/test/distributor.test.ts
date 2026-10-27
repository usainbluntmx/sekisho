import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_DISTRIBUTION_POLICY,
  NETWORKS,
  createSekishoDistributor,
  createSekishoPaymentClient,
  decideDistribution,
  type SekishoClient,
} from "../src/index.js";

const usdc = (amount: string) => parseUnits(amount, 6);
const MERCHANT = "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae" as Address;
const OTHER = "0x0000000000000000000000000000000000000B0b" as Address;
const TX = `0x${"ab".repeat(32)}` as const;

describe("decideDistribution", () => {
  const P = DEFAULT_DISTRIBUTION_POLICY;

  it("sin saldo no reparte", () => {
    expect(decideDistribution({ pendingAtomic: 0n, oldestPendingHours: 500 }, P, true)).toEqual({
      distribute: false,
      reason: "empty",
    });
  });

  it("reparte al alcanzar el umbral", () => {
    expect(decideDistribution({ pendingAtomic: usdc("5"), oldestPendingHours: 0 }, P).reason).toBe("threshold");
  });

  it("reparte por antigüedad desde el piso (0.25 USDC a las 24 h)", () => {
    expect(decideDistribution({ pendingAtomic: usdc("0.25"), oldestPendingHours: 24 }, P)).toEqual({
      distribute: true,
      reason: "max_age",
    });
  });

  it("no reparte polvo aunque pase una semana (0.02 USDC a 168 h)", () => {
    expect(decideDistribution({ pendingAtomic: usdc("0.02"), oldestPendingHours: 168 }, P)).toEqual({
      distribute: false,
      reason: "waiting",
    });
  });

  it("reparte antes de una subida de fee programada", () => {
    const state = { pendingAtomic: usdc("1"), oldestPendingHours: 1, feeChange: { hoursLeft: 40, increase: true } };
    expect(decideDistribution(state, P).reason).toBe("fee_change");
  });

  it("una bajada de fee no fuerza el reparto", () => {
    const state = { pendingAtomic: usdc("1"), oldestPendingHours: 1, feeChange: { hoursLeft: 1, increase: false } };
    expect(decideDistribution(state, P).reason).toBe("waiting");
  });

  it("el cambio de fee respeta el piso", () => {
    const state = { pendingAtomic: usdc("0.10"), oldestPendingHours: 1, feeChange: { hoursLeft: 1, increase: true } };
    expect(decideDistribution(state, P).reason).toBe("waiting");
  });

  it("force reparte cualquier saldo", () => {
    expect(decideDistribution({ pendingAtomic: 1n, oldestPendingHours: null }, P, true).reason).toBe("forced");
  });
});

/** Cliente simulado: un saldo por vendedor y distribute() que lo deja en 0. */
function mockSekisho(balances: Record<string, bigint>, feeChange: { feeBps: number; effectiveAt: Date } | null = null) {
  const distribute = vi.fn(async (merchant: Address) => {
    balances[merchant] = 0n;
    return TX;
  });
  const client = {
    network: "avalancheFuji",
    config: NETWORKS.avalancheFuji,
    getConfig: async () => ({ feeBps: 150, feeChange }),
    pending: async (merchant: Address) => {
      const total = balances[merchant] ?? 0n;
      const fee = (total * 150n) / 10_000n;
      return { vault: MERCHANT, deployed: true, total, fee, merchantAmount: total - fee };
    },
    distribute,
  } as unknown as SekishoClient;
  return { client, distribute };
}

describe("createSekishoDistributor", () => {
  afterEach(() => vi.useRealTimers());

  it("reparte por umbral y avisa con onDistributed", async () => {
    const { client, distribute } = mockSekisho({ [MERCHANT]: usdc("5") });
    const onDistributed = vi.fn();
    const distributor = createSekishoDistributor({ sekisho: client, merchants: [MERCHANT], onDistributed, log: () => {} });

    const [result] = await distributor.check();
    expect(result.tx).toBe(TX);
    expect(distribute).toHaveBeenCalledWith(MERCHANT);
    expect(onDistributed).toHaveBeenCalledWith(
      expect.objectContaining({ merchant: MERCHANT, total: usdc("5"), fee: usdc("0.075"), reason: "threshold" })
    );
  });

  it("espera montos pequeños y los reparte cuando el pago cumple 24 h", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-27T00:00:00Z") });
    const { client, distribute } = mockSekisho({ [MERCHANT]: usdc("1") });
    const distributor = createSekishoDistributor({ sekisho: client, merchants: [MERCHANT], log: () => {} });

    distributor.notePayment(MERCHANT);
    expect((await distributor.check())[0].decision.reason).toBe("waiting");

    vi.setSystemTime(new Date("2026-10-28T00:00:01Z"));
    expect((await distributor.check())[0].decision.reason).toBe("max_age");
    expect(distribute).toHaveBeenCalledTimes(1);
  });

  it("tras reiniciar, la antigüedad cuenta desde la primera revisión con saldo", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-27T00:00:00Z") });
    const { client } = mockSekisho({ [MERCHANT]: usdc("1") });
    const distributor = createSekishoDistributor({ sekisho: client, merchants: [MERCHANT], log: () => {} });

    expect((await distributor.check())[0].decision.reason).toBe("waiting");
    vi.setSystemTime(new Date("2026-10-27T23:00:00Z"));
    expect((await distributor.check())[0].decision.reason).toBe("waiting");
    vi.setSystemTime(new Date("2026-10-28T00:00:00Z"));
    expect((await distributor.check())[0].decision.reason).toBe("max_age");
  });

  it("reparte antes de que aplique una subida de fee", async () => {
    const effectiveAt = new Date(Date.now() + 24 * 3_600_000);
    const { client } = mockSekisho({ [MERCHANT]: usdc("1") }, { feeBps: 300, effectiveAt });
    const distributor = createSekishoDistributor({ sekisho: client, merchants: [MERCHANT], log: () => {} });
    expect((await distributor.check())[0].decision.reason).toBe("fee_change");
  });

  it("un vendedor que falla no detiene a los demás", async () => {
    const { client, distribute } = mockSekisho({ [MERCHANT]: usdc("5"), [OTHER]: usdc("5") });
    distribute.mockImplementationOnce(async () => {
      throw new Error("sin AVAX para gas");
    });
    const onError = vi.fn();
    const distributor = createSekishoDistributor({ sekisho: client, merchants: [MERCHANT, OTHER], onError, log: () => {} });

    const results = await distributor.check();
    expect(results[0].error).toBe("sin AVAX para gas");
    expect(results[1].tx).toBe(TX);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), MERCHANT);
  });

  it("no corre dos revisiones a la vez", async () => {
    const { client } = mockSekisho({ [MERCHANT]: usdc("5") });
    const distributor = createSekishoDistributor({ sekisho: client, merchants: [MERCHANT], log: () => {} });
    const [first, second] = await Promise.all([distributor.check(), distributor.check()]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("acepta la lista de vendedores como función", async () => {
    const { client } = mockSekisho({ [MERCHANT]: usdc("5") });
    const distributor = createSekishoDistributor({ sekisho: client, merchants: async () => [MERCHANT], log: () => {} });
    expect((await distributor.check())[0].tx).toBe(TX);
  });

  it("rechaza montos inválidos en la política al crearse", () => {
    const { client } = mockSekisho({});
    expect(() =>
      createSekishoDistributor({ sekisho: client, merchants: [], policy: { minUsdc: "cinco" }, log: () => {} })
    ).toThrow();
  });
});

describe("topes de gasto del agente", () => {
  const FUJI = NETWORKS.avalancheFuji;
  const paymentRequired = (amount: string) => ({
    x402Version: 2,
    resource: { url: "http://test.local/premium", description: "test", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:43113",
        amount,
        asset: FUJI.usdc,
        payTo: MERCHANT,
        maxTimeoutSeconds: 300,
        extra: { ...FUJI.usdcEip712 },
      },
    ],
  });
  const account = () => privateKeyToAccount(generatePrivateKey());

  it("maxPerSession: tres pagos de 0.50 con tope de 1 → el tercero no se firma", async () => {
    const client = createSekishoPaymentClient({ account: account(), maxPerSession: "1" });
    await client.createPaymentPayload(paymentRequired("500000") as never);
    await client.createPaymentPayload(paymentRequired("500000") as never);
    await expect(client.createPaymentPayload(paymentRequired("500000") as never)).rejects.toThrow(/sesión/);
  });

  it("maxPerDay: el tope se libera pasadas 24 horas", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-27T00:00:00Z") });
    const client = createSekishoPaymentClient({ account: account(), maxPerDay: "0.5" });
    await client.createPaymentPayload(paymentRequired("500000") as never);
    await expect(client.createPaymentPayload(paymentRequired("1") as never)).rejects.toThrow(/24 horas/);
    vi.setSystemTime(new Date("2026-10-28T00:00:01Z"));
    await expect(client.createPaymentPayload(paymentRequired("500000") as never)).resolves.toBeDefined();
    vi.useRealTimers();
  });

  it("sin topes de sesión o día el comportamiento no cambia", async () => {
    const client = createSekishoPaymentClient({ account: account() });
    for (let i = 0; i < 3; i++) {
      await expect(client.createPaymentPayload(paymentRequired("500000") as never)).resolves.toBeDefined();
    }
  });
});
