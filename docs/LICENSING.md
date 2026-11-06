# Licensing

- Current licence: GNU Affero General Public License v3.0 only (`AGPL-3.0-only`); see `LICENSE`.
- Previous licence: MIT, published by "LocalSwap contributors". Snapshots released earlier remain available under MIT.
- Decision: relicensing to AGPL-3.0-only was decided on 2026-11-06 by the owner, who holds the copyright.
- Third-party packages keep their own licences; see `THIRD_PARTY_NOTICES.md`.
- WalletConnect / Reown was removed on 2026-11-06 because the Reown Community License is incompatible with AGPL-3.0. Wallets connect through injected providers only (EIP-1193 / EIP-6963).

## Known remaining items (to do at the next release re-pin)

- The eight Solidity sources under `contracts/` still carry `SPDX-License-Identifier: MIT`. Changing a header changes the compiled metadata hash and therefore the pinned artifact hashes, so it is left for the re-pin step. MIT is AGPL-compatible.
- The root `package.json` license field now reads `AGPL-3.0-only` and its dependency list no longer includes WalletConnect, so any release ID or hash computed from the earlier file must be regenerated.
- `src/release/v01-profile-matches-tree.test.ts` is suspended (`PIN_PREDATES_RELICENSE`) because the tree no longer builds the release that was deployed to the public testnet. Rebuild, deploy and re-pin, then set the flag to `false`.
