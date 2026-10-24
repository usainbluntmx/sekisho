import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient } from "viem";
import { NETWORKS, createSekishoTransport } from "../src/index.js";

const FUJI = NETWORKS.avalancheFuji;

/** Servidor RPC local: responde con `status`, y a eth_chainId con Fuji (0xa869) si status es 200. */
function rpcServer(status: number): Promise<{ url: string; hits: () => number; server: Server }> {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (status !== 200) {
        res.writeHead(status).end("blocked");
        return;
      }
      const { id } = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0xa869" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, hits: () => count, server });
    });
  });
}

describe("createSekishoTransport", () => {
  let blocked: Awaited<ReturnType<typeof rpcServer>>;
  let healthy: Awaited<ReturnType<typeof rpcServer>>;

  beforeAll(async () => {
    blocked = await rpcServer(403);
    healthy = await rpcServer(200);
  });
  afterAll(() => {
    blocked.server.close();
    healthy.server.close();
  });

  it("lists every network with at least two public RPCs", () => {
    for (const config of Object.values(NETWORKS)) {
      expect(config.rpcUrls.length).toBeGreaterThanOrEqual(2);
      expect(config.rpcUrl).toBe(config.rpcUrls[0]);
    }
  });

  it("puts the user's RPC first and keeps the public ones as backup, without duplicates", () => {
    const transport = createSekishoTransport(FUJI, ["https://my.rpc", FUJI.rpcUrls[1]]);
    const { value } = transport({ chain: FUJI.chain }) as unknown as {
      value: { transports: { value: { url: string } }[] };
    };
    const urls = value.transports.map((t) => t.value.url);
    expect(urls).toEqual(["https://my.rpc", FUJI.rpcUrls[1], FUJI.rpcUrls[0]]);
  });

  it("falls back to the next RPC when the first one answers 403", async () => {
    const client = createPublicClient({
      chain: FUJI.chain,
      transport: createSekishoTransport({ ...FUJI, rpcUrls: [] }, [blocked.url, healthy.url]),
    });
    await expect(client.getChainId()).resolves.toBe(43113);
    expect(blocked.hits()).toBeGreaterThanOrEqual(1);
    expect(healthy.hits()).toBeGreaterThanOrEqual(1);
  });
});