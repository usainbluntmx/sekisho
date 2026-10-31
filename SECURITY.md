# Security

Sekisho is live on **Avalanche C-Chain mainnet** (factory `0xeB43A8b678E0b4ee7f11bd2867bC8B5EaC9444A6`), with a Fuji testnet deployment for development. Contracts are verified, tested and statically analyzed but have not had a professional audit yet: start with small amounts.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) instead of a public issue.

## Contract guarantees

- Platform fee hard-capped at 10% (`MAX_FEE_BPS`), enforced in the contract. Every fee change applies 7 days after it is scheduled (`FEE_CHANGE_DELAY`), visible on-chain through `pendingFeeChange()` (SDK: `getFeeChange()`).
- Vaults have no withdraw function: funds only leave through `distribute()`, to the treasury and the merchant.
- Merchant rotation is two-step (propose by the current merchant, accept by the new address).
- On mainnet, owner and treasury are a Safe 2-of-3 multisig (`0xbABB7B7C35438B2Ab646da3C820859062ACEA3Dc`) set in the factory constructor; the deployer key holds no role. The server's operator key has no permissions on the contracts.

## Known limits

These are design decisions of the v3 contracts, documented so integrators can plan around them.

- **The fee is applied at split time.** A scheduled fee change opens a 7-day window, not a lock: funds still pending when it applies are split at the new rate. `distribute()` is permissionless, so anyone can split before the deadline; the SDK's distributor does it automatically when it sees a scheduled increase (`feeChangeHours`, 48 h by default).
- **Splits need a caller.** Payments wait in the vault until someone calls `distribute()` and pays its gas. The SDK includes a distributor (`createSekishoDistributor`) and a standalone keeper example; without one, funds stay safe in the vault but are not paid out.
- **`setTreasury` has no delay.** The owner (the Safe) can change the treasury immediately. It only affects where the platform fee goes, which is capped at 10%; the seller's share is never affected.
- **Funds at a predicted vault block rotation to that address.** If USDC is sent to the not-yet-deployed vault address of a new payout address, `acceptMerchant` reverts with `CounterfactualFunds` (otherwise those funds would be stranded). Anyone can trigger this by sending dust; the fix is to rotate to a different address. No funds are lost.

## Static analysis

[Slither](https://github.com/crytic/slither) 0.11.6 runs in CI on every push (`--fail-low`, all 102 detectors). Current result: **0 findings**. Eight results were triaged as false positives or intended design and are suppressed inline with `slither-disable-next-line` and a comment explaining why:

| Detector | Where | Why it is safe |
| --- | --- | --- |
| `reentrancy-no-eth`, `reentrancy-events` | `SplitVaultFactory.createVault` | `initialize()` runs on the freshly created clone (our own implementation, no external calls). |
| `reentrancy-events` | `SplitVault.acceptMerchant` | The external call goes to the factory that created the vault. |
| `incorrect-equality` | `SplitVault.distribute` | `total == 0` only prevents an empty split; any forced balance is split with the same fixed destinations. |
| `timestamp` (×4) | Fee delay in `SplitVaultFactory` | The delay is 7 days; validator timestamp drift of a few seconds is irrelevant. |

Static analysis is not a substitute for a professional audit, which is recommended before significant mainnet volume.

## Known dependency advisories

Production dependencies are audited in CI (`npm audit --omit=dev --audit-level=high`) for `sdk/`, `apps/kanjo/`, `apps/demo-api/` and `apps/web/`; all four report 0 vulnerabilities.

Resolved: [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (`zod` < 4.6.6, high) came through `@x402/*` 2.28.0. `@x402/*` 2.29.0 requires zod ≥ 4.6.6; the SDK moved to it in 0.5.2.

| Advisory | Where | Exposure | Mitigation / status |
| --- | --- | --- | --- |
| `elliptic` (critical, no patched version) and other advisories in the Hardhat 2 toolchain | `backend/` dev dependencies only (via `hardhat-deploy` / ethers v5 and `hardhat-network-helpers` v1) | Only the machine that compiles and deploys. Nothing is deployed from these packages. | The deployer key holds no role on the contracts (on mainnet, owner and treasury are the Safe). Migration to Hardhat 3 is planned after the mainnet launch; the deployed bytecode will be compared to prove the contracts don't change. |