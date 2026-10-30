import { describe, expect, it } from "vitest";
import { decodeEventLog, encodeAbiParameters, encodeEventTopics } from "viem";
import { NETWORKS, splitVaultAbi, splitVaultFactoryAbi } from "../src/index.js";

const MERCHANT = "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae";
const VAULT = "0xBF15daBBA09b63ee956c06C0234F8992443B8e36";

describe("eventos en los ABI (0.5.1)", () => {
  it("decodifica Distributed de un vault", () => {
    const topics = encodeEventTopics({ abi: splitVaultAbi, eventName: "Distributed", args: { token: NETWORKS.avalanche.usdc } });
    const data = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [10_000n, 150n, 9_850n]);
    const event = decodeEventLog({ abi: splitVaultAbi, topics, data });
    expect(event.eventName).toBe("Distributed");
    expect(event.args).toMatchObject({ total: 10_000n, fee: 150n, merchantAmount: 9_850n });
  });

  it("decodifica VaultCreated de la factory", () => {
    const topics = encodeEventTopics({ abi: splitVaultFactoryAbi, eventName: "VaultCreated", args: { merchant: MERCHANT, vault: VAULT } });
    const event = decodeEventLog({ abi: splitVaultFactoryAbi, topics, data: "0x" });
    expect(event.eventName).toBe("VaultCreated");
    expect(event.args).toEqual({ merchant: MERCHANT, vault: VAULT });
  });
});
