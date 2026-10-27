import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseTransaction, toFunctionSelector, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORKS, createSekishoClient, splitVaultAbi } from "../src/index.js";

const FUJI = NETWORKS.avalancheFuji;
const VAULT = "0xc3D7e1892b5ee352eDA1974406F2462865D95409" as const;
const MERCHANT = "0xAdc41EBCd5e6cBaC36B688a1c447262A17c56dae" as const;
const NEW_MERCHANT = "0x2156c2E9fD42F5A742CF4056577fA1a65dCa5f96" as const;
const word = (address: string) => `0x${"00".repeat(12)}${address.slice(2).toLowerCase()}`;

type CallHandler = (data: Hex) => { result?: Hex; revert?: Hex };

/** RPC local: eth_call lo decide `onCall`; las transacciones se guardan crudas. */
function mockRpc(onCall: CallHandler): Promise<{ url: string; calls: Hex[]; sent: Hex[]; server: Server }> {
  const calls: Hex[] = [];
  const sent: Hex[] = [];
  const results: Record<string, (params: any[]) => unknown> = {
    eth_chainId: () => "0xa869",
    eth_estimateGas: () => "0xc350",
    eth_getTransactionCount: () => "0x0",
    eth_maxPriorityFeePerGas: () => "0x1",
    eth_blockNumber: () => "0x2",
    eth_getBlockByNumber: () => ({
      number: "0x1",
      hash: `0x${"11".repeat(32)}`,
      parentHash: `0x${"00".repeat(32)}`,
      timestamp: "0x1",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      baseFeePerGas: "0x64",
      transactions: [],
    }),
    eth_sendRawTransaction: (params) => {
      sent.push(params[0]);
      return `0x${"ab".repeat(32)}`;
    },
    eth_getTransactionReceipt: () => ({
      transactionHash: `0x${"ab".repeat(32)}`,
      transactionIndex: "0x0",
      blockHash: `0x${"11".repeat(32)}`,
      blockNumber: "0x1",
      from: `0x${"00".repeat(20)}`,
      to: `0x${"00".repeat(20)}`,
      cumulativeGasUsed: "0xc350",
      gasUsed: "0xc350",
      effectiveGasPrice: "0x64",
      contractAddress: null,
      logs: [],
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      type: "0x2",
    }),
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      let payload: object;
      if (method === "eth_call") {
        const data = params[0].data as Hex;
        calls.push(data);
        const answer = onCall(data);
        payload = answer.revert
          ? { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: answer.revert } }
          : { jsonrpc: "2.0", id, result: answer.result };
      } else if (results[method]) {
        payload = { jsonrpc: "2.0", id, result: results[method](params) };
      } else {
        payload = { jsonrpc: "2.0", id, error: { code: -32601, message: `no mock for ${method}` } };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, sent, server })
    )
  );
}

const RESOLVE_PAY_TO = toFunctionSelector("resolvePayTo(address)");
const VAULT_OF = toFunctionSelector("vaultOf(address)");

describe("SekishoClient v2", () => {
  it("enables Avalanche C-Chain mainnet with the v3 factory and Circle USDC", () => {
    const MAINNET = NETWORKS.avalanche;
    expect(MAINNET.chain.id).toBe(43114);
    expect(MAINNET.factory).toBe("0xeB43A8b678E0b4ee7f11bd2867bC8B5EaC9444A6");
    expect(MAINNET.usdc).toBe("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E");
    expect(() => createSekishoClient({ network: "avalanche" })).not.toThrow();
  });

  it("keeps Fuji as the default network", () => {
    expect(createSekishoClient().network).toBe("avalancheFuji");
  });
  it("uses the v3 factory on Fuji", () => {
    expect(FUJI.factory).toBe("0x1fC9C58DfbBDa2d0508b12800859e54f4f3519Ab");
  });

  it("getFeeChange returns null when nothing is scheduled and the change when there is one", async () => {
    const effectiveAt = 1_800_000_000;
    let scheduled = false;
    const rpc = await mockRpc(() => ({
      result: scheduled
        ? (`0x${(500).toString(16).padStart(64, "0")}${effectiveAt.toString(16).padStart(64, "0")}` as Hex)
        : (`0x${"00".repeat(64)}` as Hex),
    }));
    try {
      const sekisho = createSekishoClient({ rpcUrl: rpc.url });
      expect(await sekisho.getFeeChange()).toBeNull();
      scheduled = true;
      expect(await sekisho.getFeeChange()).toEqual({ feeBps: 500, effectiveAt: new Date(effectiveAt * 1000) });
      expect(rpc.calls.at(-1)!.startsWith(toFunctionSelector("pendingFeeChange()"))).toBe(true);
    } finally {
      rpc.server.close();
    }
  });

  it("getPayTo asks the factory for resolvePayTo", async () => {
    const rpc = await mockRpc(() => ({ result: word(VAULT) as Hex }));
    try {
      const sekisho = createSekishoClient({ rpcUrl: rpc.url });
      expect(await sekisho.getPayTo(MERCHANT)).toBe(VAULT);
      expect(rpc.calls[0].startsWith(RESOLVE_PAY_TO)).toBe(true);
    } finally {
      rpc.server.close();
    }
  });

  it("getPayTo refuses a merchant that rotated away (MerchantRetired)", async () => {
    const rpc = await mockRpc(() => ({ revert: toFunctionSelector("MerchantRetired()") }));
    try {
      const sekisho = createSekishoClient({ rpcUrl: rpc.url });
      await expect(sekisho.getPayTo(MERCHANT)).rejects.toThrow(/rotó su vault/);
    } finally {
      rpc.server.close();
    }
  });

  it("proposeMerchant finds the caller's vault and proposes the new address", async () => {
    const rpc = await mockRpc((data) =>
      data.startsWith(VAULT_OF) ? { result: word(VAULT) as Hex } : { result: "0x" }
    );
    try {
      const sekisho = createSekishoClient({ rpcUrl: rpc.url, account: privateKeyToAccount(generatePrivateKey()) });
      await sekisho.proposeMerchant(NEW_MERCHANT);

      const tx = parseTransaction(rpc.sent[0]);
      expect(tx.to?.toLowerCase()).toBe(VAULT.toLowerCase());
      const call = decodeFunctionData({ abi: splitVaultAbi, data: tx.data! });
      expect(call.functionName).toBe("proposeMerchant");
      expect(call.args).toEqual([NEW_MERCHANT]);
    } finally {
      rpc.server.close();
    }
  }, 20_000);

  it("proposeMerchant fails clearly if the caller has no vault", async () => {
    const rpc = await mockRpc(() => ({ result: word("0x0000000000000000000000000000000000000000") as Hex }));
    try {
      const sekisho = createSekishoClient({ rpcUrl: rpc.url, account: privateKeyToAccount(generatePrivateKey()) });
      await expect(sekisho.proposeMerchant(NEW_MERCHANT)).rejects.toThrow(/no tiene un vault/);
      expect(rpc.sent).toHaveLength(0);
    } finally {
      rpc.server.close();
    }
  });

  it("acceptMerchant sends acceptMerchant() to the vault", async () => {
    const rpc = await mockRpc(() => ({ result: "0x" }));
    try {
      const sekisho = createSekishoClient({ rpcUrl: rpc.url, account: privateKeyToAccount(generatePrivateKey()) });
      await sekisho.acceptMerchant(VAULT);

      const tx = parseTransaction(rpc.sent[0]);
      expect(tx.to?.toLowerCase()).toBe(VAULT.toLowerCase());
      expect(decodeFunctionData({ abi: splitVaultAbi, data: tx.data! }).functionName).toBe("acceptMerchant");
    } finally {
      rpc.server.close();
    }
  }, 20_000);
  it("pending() counts payments that arrived before the vault was created", async () => {
    const rpc = await mockRpc((data) => {
      if (data.startsWith(toFunctionSelector("vaultOf(address)"))) return { result: word("0x0000000000000000000000000000000000000000") as Hex };
      if (data.startsWith(toFunctionSelector("resolvePayTo(address)"))) return { result: word(VAULT) as Hex };
      if (data.startsWith(toFunctionSelector("balanceOf(address)"))) return { result: `0x${(20_000).toString(16).padStart(64, "0")}` as Hex };
      if (data.startsWith(toFunctionSelector("feeBps()"))) return { result: `0x${(150).toString(16).padStart(64, "0")}` as Hex };
      return { result: "0x" };
    });
    try {
      const sekisho = createSekishoClient({ rpcUrl: rpc.url });
      const p = await sekisho.pending(MERCHANT);
      expect(p).toEqual({ vault: VAULT, deployed: false, total: 20_000n, fee: 300n, merchantAmount: 19_700n });
    } finally {
      rpc.server.close();
    }
  });
});