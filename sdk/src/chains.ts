import type { Address, Chain } from "viem";
import { avalanche, avalancheFuji } from "viem/chains";

export type SekishoNetwork = "avalancheFuji" | "avalanche";

export interface NetworkConfig {
  chain: Chain;
  /** RPCs públicas en orden de preferencia; el SDK pasa a la siguiente si una falla. */
  rpcUrls: readonly string[];
  explorer: string;
  usdc: Address;
  /** Dominio EIP-712 del USDC (necesario para firmas EIP-3009 en x402). */
  usdcEip712: { name: string; version: string };
  factory?: Address;
}

export const NETWORKS: Record<SekishoNetwork, NetworkConfig> = {
  avalancheFuji: {
    chain: avalancheFuji,
    rpcUrls: [
      "https://api.avax-test.network/ext/bc/C/rpc",
      "https://avalanche-fuji-c-chain-rpc.publicnode.com",
    ],
    explorer: "https://testnet.snowtrace.io",
    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
    usdcEip712: { name: "USD Coin", version: "2" },
    factory: "0x1fC9C58DfbBDa2d0508b12800859e54f4f3519Ab", // SplitVaultFactory v3
  },
  avalanche: {
    chain: avalanche,
    rpcUrls: [
      "https://api.avax.network/ext/bc/C/rpc",
      "https://avalanche-c-chain-rpc.publicnode.com",
    ],
    explorer: "https://snowtrace.io",
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    usdcEip712: { name: "USD Coin", version: "2" },
    // factory: se agrega cuando despleguemos en mainnet
  },
};