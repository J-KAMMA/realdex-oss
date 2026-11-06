# Third-party licences

RealDEX itself is licensed AGPL-3.0-only (see `LICENSE`), except the Solidity
sources under `contracts/`, which keep their `SPDX-License-Identifier: MIT`
header (changing a Solidity source header changes the compiled metadata hash
and would invalidate pinned artifact hashes; MIT is AGPL-compatible).

This file is generated from `pnpm-lock.yaml` joined with the `license` field
(or the shipped LICENSE file where the field is missing) of each package as
installed under `node_modules/.pnpm` on 2026-11-06. 544 of 622 lockfile entries
were inspected; the remaining 78 are platform-specific optional binaries
(`@esbuild/*`, `@rollup/*`, `@img/*` and similar) that were not installed on this
Linux x64 host and carry the licence of their parent package (MIT in every case
checked). Regenerate before each release; this is a snapshot, not a legal opinion.

## Compatibility flags (read first)

| Package | Licence | AGPL-3.0 position |
|---|---|---|
| `rpc-websockets` 9.3.9 | LGPL-3.0-only | Compatible (LGPL-3.0 may be combined with AGPL-3.0). Keep it as an unmodified, replaceable dependency and keep its notice. |
| `@ethereumjs/rlp`, `@ethereumjs/util` | MPL-2.0 | Compatible (MPL-2.0 s.3.3 allows combination with AGPL). Keep file-level source availability for those files (they are unmodified npm packages). |
| Apache-2.0 packages (incl. `@circle-fin/*`) | Apache-2.0 | Compatible with GPL-3.0/AGPL-3.0. Keep their NOTICE/licence files when redistributing. |
| `@circle-fin/*` | package.json has no `license` field; the shipped `LICENSE` file is Apache-2.0 | Compatible; consider asking upstream to add the field. |

No other package in the lockfile uses a copyleft licence incompatible with AGPL-3.0.

## Summary by licence

| Licence | Packages |
|---|---|
| MIT | 450 |
| ISC | 29 |
| Apache-2.0 | 27 |
| BSD-3-Clause | 15 |
| BlueOak-1.0.0 | 4 |
| BSD-2-Clause | 3 |
| 0BSD | 3 |
| (MIT OR CC0-1.0) | 3 |
| MPL-2.0 | 2 |
| (MIT OR Apache-2.0) | 1 |
| MIT-0 | 1 |
| Python-2.0 | 1 |
| CC-BY-4.0 | 1 |
| WTFPL | 1 |
| (MIT AND Zlib) | 1 |
| LGPL-3.0-only | 1 |
| Unlicense (public domain dedication) | 1 |
| (Apache-2.0 AND MIT) | 0 |

## Packages by licence

### MIT (450)

Very large group; see `pnpm-lock.yaml` for the list. Packages not named elsewhere in this file carry this licence.

### ISC (29)

- @isaacs/cliui@8.0.2
- ansi-align@3.0.1
- browser-stdout@1.3.1
- cliui@8.0.1
- electron-to-chromium@1.5.418
- foreground-child@3.3.1
- get-caller-file@2.0.5
- glob@10.5.0
- graceful-fs@4.2.11
- inherits@2.0.4
- isexe@2.0.0
- json-stringify-safe@5.0.1
- lru-cache@10.4.3
- lru-cache@5.1.1
- lucide-react@0.468.0
- minimalistic-assert@1.0.1
- minimatch@9.0.9
- picocolors@1.1.1
- saxes@6.0.0
- semver@5.7.2
- semver@6.3.1
- setprototypeof@1.2.0
- siginfo@2.0.0
- signal-exit@4.1.0
- split2@4.2.0
- which@2.0.2
- y18n@5.0.8
- yallist@3.1.1
- yargs-parser@21.1.1

### Apache-2.0 (27)

- @circle-fin/adapter-solana-kit@1.6.1
- @circle-fin/adapter-viem-v2@1.17.0
- @circle-fin/bridge-kit@1.14.0
- @circle-fin/provider-cctp-v2@1.12.0
- @circle-fin/provider-fee-v1@0.2.0
- @coral-xyz/anchor-errors@0.31.1
- @coral-xyz/borsh@0.31.1
- @cosmjs/amino@0.39.0
- @cosmjs/crypto@0.39.0
- @cosmjs/encoding@0.39.0
- @cosmjs/json-rpc@0.39.0
- @cosmjs/math@0.39.0
- @cosmjs/proto-signing@0.39.0
- @cosmjs/socket@0.39.0
- @cosmjs/stargate@0.39.0
- @cosmjs/stream@0.39.0
- @cosmjs/tendermint-rpc@0.39.0
- @cosmjs/utils@0.39.0
- @swc/helpers@0.5.23
- baseline-browser-mapping@2.11.20
- borsh@0.7.0
- cosmjs-types@0.11.0
- expect-type@1.4.0
- readonly-date-esm@2.0.0
- typescript@5.9.3
- workerpool@9.3.4
- xml-name-validator@5.0.0

### BSD-3-Clause (15)

- @sentry/core@5.30.0
- @sentry/hub@5.30.0
- @sentry/minimal@5.30.0
- @sentry/node@5.30.0
- @sentry/types@5.30.0
- @sentry/utils@5.30.0
- diff@7.0.0
- flat@5.0.2
- ieee754@1.2.1
- serialize-javascript@6.0.2
- source-map-js@1.2.1
- source-map@0.6.1
- stream-chain@2.2.5
- stream-json@1.9.1
- tough-cookie@5.1.2

### BlueOak-1.0.0 (4)

- jackspeak@3.4.3
- minipass@7.1.3
- package-json-from-dist@1.0.1
- path-scurry@1.11.1

### BSD-2-Clause (3)

- entities@6.0.1
- webidl-conversions@3.0.1
- webidl-conversions@7.0.0

### 0BSD (3)

- tslib@1.14.1
- tslib@2.7.0
- tslib@2.8.1

### (MIT OR CC0-1.0) (3)

- type-fest@0.20.2
- type-fest@0.21.3
- type-fest@0.7.1

### MPL-2.0 (2)

- @ethereumjs/rlp@5.0.2
- @ethereumjs/util@9.1.0

### (MIT OR Apache-2.0) (1)

- @coral-xyz/anchor@0.31.1

### MIT-0 (1)

- @csstools/color-helpers@5.1.0

### Python-2.0 (1)

- argparse@2.0.1

### CC-BY-4.0 (1)

- caniuse-lite@1.0.30001810

### WTFPL (1)

- chai-as-promised@7.1.2

### (Apache-2.0 AND MIT) (0)

### (MIT AND Zlib) (1)

- pako@2.2.0

### LGPL-3.0-only (1)

- rpc-websockets@9.3.9

### Unlicense (public domain dedication) (1)

- text-encoding-utf-8@1.0.2


## Vendored source in this repository

- `wallet/vendor/noble-secp256k1.mjs` - @noble/secp256k1 2.2.3, MIT, (c) 2019 Paul Miller. Licence text: `wallet/vendor/LICENSE.noble-secp256k1`; provenance: `wallet/vendor/provenance.json`. Not relicensed.
- `contracts/**/*.sol` - original RealDEX/LocalSwap sources under their existing `SPDX-License-Identifier: MIT` header (MIT, (c) 2026 LocalSwap contributors; see "Licence history" in `README.md`).
