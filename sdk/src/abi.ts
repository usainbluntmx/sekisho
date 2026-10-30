import { parseAbi } from "viem";

/** SplitVaultFactory v3 (rotación de merchant, resolvePayTo y cambios de fee con retraso). */
export const splitVaultFactoryAbi = parseAbi([
  "function predictVault(address merchant) view returns (address)",
  "function resolvePayTo(address merchant) view returns (address)",
  "function vaultOf(address merchant) view returns (address)",
  "function treasury() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function pendingFeeChange() view returns (uint16 newFeeBps, uint64 effectiveAt)",
  "function FEE_CHANGE_DELAY() view returns (uint64)",
  "function settlementToken() view returns (address)",
  "function createVault(address merchant) returns (address vault)",
  "error MerchantRetired()",
  "error VaultExists()",
  "error CounterfactualFunds()",
  "error NoFeeChange()",
  "event VaultCreated(address indexed merchant, address indexed vault)",
  "event MerchantRotated(address indexed vault, address indexed previousMerchant, address indexed newMerchant)",
  "event TreasuryUpdated(address indexed treasury)",
  "event FeeUpdated(uint16 feeBps)",
  "event FeeChangeScheduled(uint16 feeBps, uint64 effectiveAt)",
  "event FeeChangeCancelled(uint16 feeBps)",
]);

/** SplitVault (v2/v3). No tiene funciones de retiro: solo distribute() mueve fondos. */
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
  "event Distributed(address indexed token, uint256 total, uint256 fee, uint256 merchantAmount)",
  "event MerchantProposed(address indexed merchant, address indexed proposed)",
  "event MerchantChanged(address indexed previousMerchant, address indexed newMerchant)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);