# Security

Sekisho is running on **Avalanche Fuji testnet**. Do not use it with real funds.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) instead of a public issue.

## Contract guarantees

- Platform fee hard-capped at 10% (`MAX_FEE_BPS`), enforced in the contract.
- Vaults have no withdraw function: funds only leave through `distribute()`, to the treasury and the merchant.
- Merchant rotation is two-step (propose by the current merchant, accept by the new address).
- Owner and treasury are cold wallets set in the factory constructor; the server's operator key has no permissions on the contracts.

## Known dependency advisories

Production dependencies are audited in CI (`npm audit --omit=dev --audit-level=critical`) for `sdk/`, `apps/kanjo/` and `apps/web/`.

| Advisory | Where | Exposure | Mitigation / status |
| --- | --- | --- | --- |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) — `zod` < 4.6.6 can exhaust memory validating oversized collections (high) | Runtime dependency of `@x402/*` 2.28.0 (latest), the SDK and Kanjō | x402 validates the `PAYMENT-SIGNATURE` header, which Node caps at 16 KB. Kanjō's webhook and dev chat use `JSON.parse`, not zod. | Kanjō rejects any body over 64 KB with 413 before parsing. Waiting for x402 to move to zod ≥ 4.6.6. |
| `elliptic` (critical, no patched version) and other advisories in the Hardhat 2 toolchain | `backend/` dev dependencies only (via `hardhat-deploy` / ethers v5 and `hardhat-network-helpers` v1) | Only the machine that compiles and deploys. Nothing is deployed from these packages. | The deployer key holds no role on the contracts (owner and treasury are cold). Migration to Hardhat 3 is planned before mainnet. |