# Changelog

## 0.3.0 — 2026-10-26

**Breaking: uses the SplitVaultFactory v3 on Avalanche Fuji (`0x1fC9C58DfbBDa2d0508b12800859e54f4f3519Ab`).** Vault addresses change again: a seller's v3 `payTo` is different from their v2 vault.

- v3 contracts: every fee change is scheduled and applies 7 days later, so already-collected funds can always be split with the fee in force when they were charged.
- `getConfig()` now includes `feeChange` (the scheduled change, or `null`).
- New `getFeeChange()` and `FeeChange` type.

## 0.2.1 — 2026-10-26

- Fix: `pending()` now reports payments sitting at a vault address that hasn't been deployed yet (it reads the USDC balance of the predicted address and applies the current fee). Before, it returned 0 until the vault existed, so batch distributors never triggered the first `distribute()`.

## 0.2.0 — 2026-10-26

**Breaking: uses the SplitVaultFactory v2 on Avalanche Fuji (`0x198F21AF47221bb06dAAf8e4F5eB46F9ba388807`).** Vault addresses change: a seller's v2 `payTo` is different from their v1 vault.

- `getPayTo` uses the factory's `resolvePayTo`: the registered vault, the predicted one if it doesn't exist yet, or an error if the seller rotated to another address.
- New merchant rotation (two-step): `proposeMerchant`, `acceptMerchant`, `pendingMerchant`.
- ABIs updated for v2 (rotation functions and custom errors).
- Removed (deprecated since 0.1.2 / 0.1.3): `DEFAULT_FACILITATOR_URL` and `NetworkConfig.rpcUrl` (use `rpcUrls`).

## 0.1.5 — 2026-10-26

- Fix: the gas cap now applies to every transaction the SDK sends, not only self-facilitated settlements. `SekishoClient.createVault` and `distribute` estimate gas and cap it (estimate + 20%, max 1,000,000), so an RPC returning an absurd `eth_estimateGas` no longer fails with "exceeds block gas limit".

## 0.1.4 — 2026-10-24

- Fix: the self-facilitator now estimates settlement gas itself and caps it (estimate + 20%, max 1,000,000). An RPC returning an absurd `eth_estimateGas` value no longer makes settlement fail with "exceeds block gas limit".
- New exports: `settlementGasLimit`, `SETTLEMENT_GAS_CAP`.

## 0.1.3 — 2026-10-23

- RPC fallback: each network ships with several public RPCs (Avalanche official + publicnode). If one fails (403, 429, 5xx, timeout), requests move to the next one automatically.
- `rpcUrl` accepts a string or a list; custom RPCs go first and the public ones stay as backup.
- New `NetworkConfig.rpcUrls` and `createSekishoTransport` export. `NetworkConfig.rpcUrl` is deprecated and will be removed in 0.2.0.

## 0.1.2 — 2026-10-22

- Test suite (Vitest) covering payment options, agent spend limits and self-facilitation; CI on every push.
- New `SDK_VERSION` export; the MCP client now reports the real package version.
- `DEFAULT_FACILITATOR_URL` is deprecated in favor of `createSekishoFacilitator` (self-facilitation) and will be removed in 0.2.0.

## 0.1.1 — 2026-10-19

- Fix: runtime dependencies (`@x402/*`, `@modelcontextprotocol/sdk`, `zod`) moved from `devDependencies` to `dependencies`.

## 0.1.0 — 2026-10-19 (deprecated)

- Initial release: on-chain client, x402 payment options, paying agent fetch, self-facilitator and paid MCP tools on Avalanche Fuji.