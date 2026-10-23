# Changelog

## 0.1.2 — 2026-10-22

- Test suite (Vitest) covering payment options, agent spend limits and self-facilitation; CI on every push.
- New `SDK_VERSION` export; the MCP client now reports the real package version.
- `DEFAULT_FACILITATOR_URL` is deprecated in favor of `createSekishoFacilitator` (self-facilitation) and will be removed in 0.2.0.

## 0.1.1 — 2026-10-19

- Fix: runtime dependencies (`@x402/*`, `@modelcontextprotocol/sdk`, `zod`) moved from `devDependencies` to `dependencies`.

## 0.1.0 — 2026-10-19 (deprecated)

- Initial release: on-chain client, x402 payment options, paying agent fetch, self-facilitator and paid MCP tools on Avalanche Fuji.