import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createWalletClient, http, parseAbi, parseTransaction, publicActions, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { SETTLEMENT_GAS_CAP, settlementGasLimit } from "../src/index.js";
import { writeContractWithGasCap } from "../src/facilitator.js";

/** RPC local que responde lo mínimo para enviar una tx y guarda la tx cruda recibida. */
function mockRpc(estimate: Hex): Promise<{ url: string; sent: Hex[]; server: Server }> {
  const sent: Hex[] = [];
  const results: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => "0xa869",
    eth_estimateGas: () => estimate,
    eth_getTransactionCount: () => "0x7",
    eth_maxPriorityFeePerGas: () => "0x1",
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
      sent.push(params[0] as Hex);
      return `0x${"ab".repeat(32)}`;
    },
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      const handler = results[method];
      const payload = handler
        ? { jsonrpc: "2.0", id, result: handler(params) }
        : { jsonrpc: "2.0", id, error: { code: -32601, message: `no mock for ${method}` } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent, server })
    )
  );
}

const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65" as const;
const transferCall = {
  address: USDC as Hex,
  abi: parseAbi(["function transfer(address to, uint256 value) returns (bool)"]),
  functionName: "transfer",
  args: ["0x6827B96001EE85eF16fa7a85c4A7daf62CD4AC2f", 20000n] as const,
};

async function sentGas(estimate: Hex): Promise<bigint> {
  const rpc = await mockRpc(estimate);
  try {
    const client = createWalletClient({
      account: privateKeyToAccount(generatePrivateKey()),
      chain: avalancheFuji,
      transport: http(rpc.url, { retryCount: 0 }),
    }).extend(publicActions);
    await writeContractWithGasCap(client, transferCall);
    return parseTransaction(rpc.sent[0]).gas!;
  } finally {
    rpc.server.close();
  }
}

describe("settlement gas limit", () => {
  it("pads a normal estimate by 20%", () => {
    expect(settlementGasLimit(102_800n)).toBe(123_360n);
  });

  it("never exceeds the cap", () => {
    expect(settlementGasLimit(2_964_519_140_687_938n)).toBe(SETTLEMENT_GAS_CAP);
  });

  it("sends a normal settlement with estimate + 20%", async () => {
    expect(await sentGas("0x19190")).toBe(123_360n); // 102 800 gas estimados
  });

  it("caps an absurd RPC estimate instead of failing with 'exceeds block gas limit'", async () => {
    expect(await sentGas("0xa8836e64f8042")).toBe(SETTLEMENT_GAS_CAP);
  });
});