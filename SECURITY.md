# Security

Sekisho is running on **Avalanche Fuji testnet**. Do not use it with real funds.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) instead of a public issue.

## Contract guarantees

- Platform fee hard-capped at 10% (`MAX_FEE_BPS`), enforced in the contract. Every fee change applies 7 days after it is scheduled (`FEE_CHANGE_DELAY`); `distribute()` is permissionless, so pending funds can always be split with the current fee first.
- Vaults have no withdraw function: funds only leave through `distribute()`, to the treasury and the merchant.
- Merchant rotation is two-step (propose by the current merchant, accept by the new address).
- Owner and treasury are cold wallets set in the factory constructor; the server's operator key has no permissions on the contracts.

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

Production dependencies are audited in CI (`npm audit --omit=dev --audit-level=critical`) for `sdk/`, `apps/kanjo/` and `apps/web/`.

| Advisory | Where | Exposure | Mitigation / status |
| --- | --- | --- | --- |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) — `zod` < 4.6.6 can exhaust memory validating oversized collections (high) | Runtime dependency of `@x402/*` 2.28.0 (latest), the SDK and Kanjō | x402 validates the `PAYMENT-SIGNATURE` header, which Node caps at 16 KB. Kanjō's webhook and dev chat use `JSON.parse`, not zod. | Kanjō rejects any body over 64 KB with 413 before parsing. Waiting for x402 to move to zod ≥ 4.6.6. |
| `elliptic` (critical, no patched version) and other advisories in the Hardhat 2 toolchain | `backend/` dev dependencies only (via `hardhat-deploy` / ethers v5 and `hardhat-network-helpers` v1) | Only the machine that compiles and deploys. Nothing is deployed from these packages. | The deployer key holds no role on the contracts (owner and treasury are cold). Migration to Hardhat 3 is planned before mainnet. |