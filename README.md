# RealDEX

RealDEX is a local-server swap tool. You run it on your own machine: a small
Node.js application serves a read-only discovery node and a private wallet UI on
localhost, and a set of Solidity/non-EVM adapters lets you quote, review and
sign swaps across several chain families. There is no operator: no hosted
front end, no relay, no fee recipient and no default route are provided by the
project. Pools, RPC endpoints and relays are whatever you configure yourself.

Fees paid on a swap stay in the pool you swap against (they accrue to its
liquidity providers); the contracts contain no protocol fee or treasury address.

## Build and run

Requirements: Node.js 24.14.0 (see `.node-version`) and pnpm 11.25.0
(`packageManager` in `package.json`).

```sh
pnpm install --frozen-lockfile
pnpm build                    # type-check and build the web UI
node app/cli.mjs doctor       # check the local environment
node app/cli.mjs start        # start the node (read-only) and wallet services
```

`start` prints a private wallet link; open it locally and do not share it.
Options: `--directory PATH`, `--node-port 8787`, `--wallet-port 8790`.
`start-realdex.sh` / `start-realdex.cmd` wrap the same command.

Tests: `pnpm test` (contracts, UI, release plan), `node app/ci.mjs --suite all
--jobs 3 --output /new/path` (full local acceptance), `node dev/source-hygiene.mjs
<branch>` (secret/path scan of all reachable history).

Wallets connect through injected browser providers (EIP-1193 / EIP-6963).
WalletConnect and Reown are not used (their licence is incompatible with
AGPL-3.0).

## Supported chains

- EVM: the LocalSwap constant-product pool, factory, router and ERC-4337-style
  smart account in `contracts/`; a registry of about 90 EVM network plans in
  `node/examples/evm-network-plans/`; wallet connection through EIP-6963.
  Selectable networks: Base, Arbitrum One, Base Sepolia, Arbitrum Sepolia,
  or any chain you configure by hand (see below).
- Non-EVM adapters (see `wallet/non-evm/`, `node/examples/multichain/`):
  Solana (incl. SPL), Bitcoin (PSBT), Cosmos / IBC (incl. Injective), Aptos,
  Stellar, Internet Computer, and read-only request formats for Algorand, NEAR,
  Starknet, Substrate, Sui, Tezos, TON, Tron and XRP Ledger.
- Cross-chain: Circle CCTP route review and a bounded IBC relayer (`relay/`).

Which families can sign and send, and which are read-only or testnet-only, is
recorded per adapter in `docs/` and in `wallet/non-evm/capabilities-*.json`.

## Networks and contracts

The project ships no contract address and runs no frontend, relay or default
route. To swap on a network you supply the contracts.

1. Choose a network: in the app open Setup and pick one of Base (8453), Arbitrum
   One (42161), Base Sepolia (84532), Arbitrum Sepolia (421614) or the local node
   (31337), or type any RPC URL and chain ID. The chain list and its well-known
   public RPC endpoints are in `src/release/evm-networks.json`. Replace the RPC
   at any time in Setup, or at build time with `VITE_REALDEX_RPC_<chainId>`
   (comma-separated URLs).
2. Deploy your own Factory and Router with your own key and RPC:
   `npx hardhat compile`, then
   `REALDEX_DEPLOYER_PRIVATE_KEY=0x… node scripts/deployEvm.mjs --network eip155:8453`
   (add `--dry-run` to price it first; `--rpc URL` overrides the endpoint;
   `REALDEX_DEPLOYER_KEY_FILE` may name a JSON file with a `privateKey` field).
   It writes `deployments/deployment-<chainId>.json`, which contains no secret.
   Contracts you did not deploy are accepted too, if their runtime code is the
   bundled LocalSwapFactory/LocalSwapRouter v1.
3. Enter the Factory and Router addresses in Setup (pools are created from the
   Factory), or load the deployment file in Universe → Release to check it
   against two independent RPC hosts. A mainnet with no Factory configured is
   refused with `NETWORK_CONTRACTS_NOT_CONFIGURED`.

The local wallet signer (`wallet/`) takes networks from its settings file
(RPC list, genesis pin, contract policy); it accepts the L1 chains in
`wallet/lib/network.mjs`. Base and Arbitrum are used through an injected
browser wallet.

## Licence

AGPL-3.0-only. See `LICENSE`. If you run a modified version as a network
service you must offer its source to its users. The Solidity files under
`contracts/` keep their `SPDX-License-Identifier: MIT` header (changing it would
change the compiled bytecode metadata and invalidate pinned artifact hashes).
Third-party licences are listed in `THIRD_PARTY_NOTICES.md`.

Licence history: earlier snapshots of this repository were published under MIT
by "LocalSwap contributors"; that code remains available under MIT from those
snapshots.

The root `package.json` license field was changed from `MIT` to `AGPL-3.0-only`
on 2026-11-06 (together with the removal of the WalletConnect dependency), so the
release IDs and hashes recorded before that date no longer match this tree; the
next release must be re-pinned. See `docs/LICENSING.md`.

## No warranty

The software is provided as is, without warranty of any kind (AGPL-3.0 sections
15 and 16). You are responsible for complying with the law that applies to you.

Security reports: see `SECURITY.md`. Contributing: see `CONTRIBUTING.md`.
Earlier README text is kept in `docs/history/README-pre-release.md`.
