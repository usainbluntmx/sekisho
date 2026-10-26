import { parseAbi } from "viem";

/** SplitVaultFactory v2 (rotación de merchant + resolvePayTo). */
export const splitVaultFactoryAbi = parseAbi([
  "function predictVault(address merchant) view returns (address)",
  "function resolvePayTo(address merchant) view returns (address)",
  "function vaultOf(address merchant) view returns (address)",
  "function treasury() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function settlementToken() view returns (address)",
  "function createVault(address merchant) returns (address vault)",
  "error MerchantRetired()",
  "error VaultExists()",
  "error CounterfactualFunds()",
]);

/** SplitVault v2. No tiene funciones de retiro: solo distribute() mueve fondos. */
export const splitVaultAbi = parseAbi([
  "function merchant() view returns (address)",
  "function pendingMerchant() view returns (address)",
  "function pending(address token) view returns (uint256 total, uint256 fee, uint256 merchantAmount)",
  "function distribute(address token) returns (uint256 fee, uint256 merchantAmount)",
  "function proposeMerchant(address newMerchant)",
  "function acceptMerchant()",
  "error NotMerchant()",
  "error NotPendingMerchant()",
  "error SameMerchant()",
  "error NothingToDistribute()",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);