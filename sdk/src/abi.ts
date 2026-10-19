import { parseAbi } from "viem";

export const splitVaultFactoryAbi = parseAbi([
  "function predictVault(address merchant) view returns (address)",
  "function vaultOf(address merchant) view returns (address)",
  "function treasury() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function createVault(address merchant) returns (address vault)",
]);

export const splitVaultAbi = parseAbi([
  "function merchant() view returns (address)",
  "function pending(address token) view returns (uint256 total, uint256 fee, uint256 merchantAmount)",
  "function distribute(address token) returns (uint256 fee, uint256 merchantAmount)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);