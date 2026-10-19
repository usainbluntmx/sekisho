import type { Address, Chain } from "viem";
import { avalanche, avalancheFuji } from "viem/chains";

export type SekishoNetwork = "avalancheFuji" | "avalanche";

export interface NetworkConfig {
  chain: Chain;
  rpcUrl: string;
  explorer: string;
  usdc: Address;
  /** Dominio EIP-712 del USDC (necesario para firmas EIP-3009 en x402). */
  usdcEip712: { name: string; version: string };
  factory?: Address;
}

export const NETWORKS: Record<SekishoNetwork, NetworkConfig> = {
  avalancheFuji: {
    chain: avalancheFuji,
    rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc",
    explorer: "https://testnet.snowtrace.io",
    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
    usdcEip712: { name: "USD Coin", version: "2" },
    factory: "0xA1967201adD1Ac57d1c72D04Ca4d9159B98C8C5D",
  },
  avalanche: {
    chain: avalanche,
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    explorer: "https://snowtrace.io",
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    usdcEip712: { name: "USD Coin", version: "2" },
    // factory: se agrega cuando despleguemos en mainnet
  },
};