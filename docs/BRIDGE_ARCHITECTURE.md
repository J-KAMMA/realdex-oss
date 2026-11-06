# v0.22 implementation note — 2026-09-06

An owner-only local ICS-20 v1 transfer adapter is now available in `wallet/bridge/`.
It uses native IBC escrow/burn/mint/refund logic, not a new RealDEX-controlled universal custody contract.
The UI and journal are RPC observers, not a desktop light client; existing CCTP and public-route release gates remain unchanged.
The test fixture creates two genuine local chains and Tendermint clients, connections and channels; it is not a production relayer.
See [v0.22 scope](v0.22/DEVELOPMENT-REPORT-JA.md). The following sections retain historical route decisions.

---

# RealDEX cross-chain architecture

Status: CCTP V2 with two bidirectional testnet pairs and IBC ICS-20 with one bidirectional testnet pair installed, 2026-09-01. Mainnet and real-asset transfer remain disabled.

## First installed route

The recommended first route is native testnet USDC in both directions between Base Sepolia and Solana Devnet using Circle CCTP V2. It was selected because one adapter can demonstrate EVM↔non-EVM address handling without adding a RealDEX liquidity pool or a bridge-wrapped asset. CCTP burns native USDC on the source and mints native USDC on the destination.

RealDEX uses Bridge Kit with error telemetry disabled and Circle's Forwarding Service. The user signs the source approval and burn; Circle supplies the burn attestation and submits the destination mint. The short-lived signed quote binds the requested amount and source-paid service fee. RealDEX adds no fee.

This is an explicit external trust boundary: Circle's issuer controls USDC and its attestation/forwarding infrastructure determines bridge liveness. The route is therefore not described as operatorless. Sources: [CCTP overview](https://developers.circle.com/cctp), [supported chains and domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains), [contract addresses](https://developers.circle.com/cctp/references/contract-addresses), [Solana programs](https://developers.circle.com/cctp/references/solana-programs), [Forwarding Service transfer flow](https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service) (retrieved 2026-08-31).

Every new CCTP recovery cursor captures the exact burn token, amount in base units, source message sender, and destination mint recipient from the quote-bound execution request. The refresh reader decodes the fixed CCTP V2 message header and BurnMessageV2 body offsets from the raw `message` bytes and requires those values plus both domains to match. Circle's decoded JSON fields cannot substitute for this local check. A different, malformed, or ambiguous message cannot advance history; historical cursors created before transfer binding remain read-only. For Base Sepolia and Arbitrum Sepolia sources, two independent public RPC hosts must also agree on the exact successful receipt and normalized logs. Exactly one canonical `MessageSent(bytes)` event must come from the reviewed MessageTransmitterV2, contain the same raw message, and have two confirmations before source inclusion. For those EVM destinations, the equivalent two-host receipt quorum requires two confirmations plus exact `MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)` and V2 `MintAndWithdraw(address,uint256,address,uint256)` logs from the reviewed MessageTransmitterV2 and TokenMessengerV2. The former binds the raw nonce, source, sender, finality and message body; the latter binds EVM recipient, chain-specific USDC, net mint and executed fee. `forwardTxHash` alone remains submission evidence. The four pinned testnet readers returned their expected chain IDs and identical 2,175-byte MessageTransmitterV2 runtime code with SHA-256 `501b4a60e24ea82032b7442d75995dee3bdbfc17b25caffc3c955eadc8c2a418` on 2026-09-02. Solana-side program/account verification remains a release gate.

The same live check found a contradictory asset state: both independently hosted Base Sepolia readers initially returned empty bytecode for Circle's documented Base Sepolia USDC address. Later on 2026-09-02 both readers again returned a 1,798-byte proxy, but RealDEX does not interpret restoration as release authority. A user-triggered read-only gate now queries exact chain ID and head plus proxy code, Circle's Zeppelinos implementation storage slot, implementation code, and strict ERC-20 name/symbol/decimals through both pinned hosts. It requires identity agreement and a maximum 12-block head difference, then returns observation evidence with execution permanently false and explicit release approval still required. Since every installed CCTP pair includes Base, all four directions remain paused before account connection, quote retrieval, or execution. This does not erase historical recovery records or weaken their finality requirements. Re-enablement requires independent source/bytecode review, any required route-binding revision, and explicit release approval.

The next release layer is now implemented as an assessment-only signed manifest. A separately pinned EIP-191 reviewer source signs the exact fresh quorum fingerprint together with both runtime identities, the official Circle repository revision and build settings, source and verification-artifact hashes, monotonic revision, and expiry. Verification cannot write the runtime gate and always returns execution/signing/submission disabled plus explicit user approval required. Production reviewer identity and verification artifacts are deliberately unconfigured. See [CCTP_ASSET_RELEASE_GATE.md](./CCTP_ASSET_RELEASE_GATE.md).

## Second installed route

Native testnet USDC is enabled in both directions between Base Sepolia and Arbitrum Sepolia using the same CCTP V2 adapter. The source wallet must be an EIP-1193 wallet on the selected source network; the destination is a separately validated EVM recipient. Circle's current testnet tables list domain 6 for Base, domain 3 for Arbitrum, the shared TokenMessengerV2 address `0x8FE6…2DAA`, and the shared MessageTransmitterV2 address `0xE737…E275`. The test USDC contracts remain chain-specific. Sources: [CCTP EVM contract addresses](https://developers.circle.com/cctp/references/contract-addresses), [USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) (retrieved 2026-08-31).

## Third installed route

USDC.n is enabled in both directions between Noble Testnet (`grand-1`) and Osmosis Testnet (`osmo-test-5`) through IBC ICS-20. The reviewed reciprocal transfer channels are Noble `channel-22` and Osmosis `channel-4280`. Noble uses native `uusdc`; Osmosis uses the traced denom `ibc/DE6792CF9E521F6AD6E9A4BDF6225C9571A3B74ACC0A529F92BC5122A39D2E58`, derived from `transfer/channel-4280/uusdc` and verified through the Osmosis denom-trace endpoint.

Before both estimation and signing, the adapter queries both REST endpoints and requires `STATE_OPEN`, `ics20-1`, and the expected reciprocal channel. It requires a Keplr-compatible signer on the exact source chain, simulates gas, checks transfer and fee balances, applies a 30% gas margin, and sets a 20-minute packet timeout. An identical intent remains locally blocked while signing, submitted, unknown, or awaiting acknowledgement. After source inclusion, RealDEX extracts exactly one matching `send_packet` sequence and channel pair, then a manual read-only refresh queries that exact destination acknowledgement. Every channel, source-transaction, acknowledgement, and CCTP message read uses a shared credential-free HTTPS GET boundary with an eight-second timeout, one-megabyte body limit, strict JSON parsing, no referrer, and no cache reuse. Timeout, oversize, malformed JSON, or transport failure preserves the prior evidence and cannot create success or retry authority. A configured REST endpoint's success or application-error value and proof height advance only to non-terminal `destination-observed`; the observed outcome is retained as evidence but cannot authorize success, failure, refund, or retry. Destination confirmation or terminal failure requires independent verification of the acknowledgement membership proof against an accepted trusted header. Contradictory outcomes for the same acknowledgement identity and proof height are rejected, as are legacy locally stored terminal claims based on REST acknowledgement evidence. Sources: [Noble testnet registry](https://github.com/cosmos/chain-registry/blob/master/testnets/nobletestnet/chain.json), [Osmosis testnet registry](https://github.com/cosmos/chain-registry/blob/master/testnets/osmosistestnet/chain.json), [reciprocal IBC path](https://github.com/cosmos/chain-registry/blob/master/testnets/_IBC/nobletestnet-osmosistestnet.json), [ICS-20 specification](https://github.com/cosmos/ibc/blob/main/spec/app/ics-020-fungible-token-transfer/README.md), [ICS-004 packet and acknowledgement semantics](https://docs.cosmos.network/ibc/v10.1.x/spec/core/ics-004-channel-and-packet-semantics/README) (reviewed 2026-09-02).

## Decision

RealDEX will not create a new universal bridge or hold bridged assets in a RealDEX custody contract. It will use a common local control plane with protocol-specific adapters:

```text
Local UI
  ├─ route registry (exact chains, assets, endpoints, review date)
  ├─ quote integrity (fingerprint + expiry + minimum received)
  ├─ wallet adapters (EVM / SVM / Cosmos / Bitcoin / others)
  ├─ protocol adapter (one explicitly reviewed implementation per route)
  └─ lifecycle + recovery journal (stored locally)
        ↓
source protocol endpoint
        ↓ verification + permissionless or provider relay
destination protocol endpoint
```

The bridge security model is the security model of the selected route. RealDEX's UI cannot make an oracle network, guardian set, validator threshold, light client, canonical rollup bridge, or custodian safer than it actually is.

## Route classes

### EVM → EVM

Use the destination's canonical bridge for a canonical L1/L2 relationship when available. For unrelated EVM chains, install a reviewed adapter for a specific interoperability protocol and lane. The route manifest must bind both chain IDs, source and destination endpoints, token representations, confirmation policy, rate limits, and evidence.

### EVM → non-EVM

Cross-VM routes must additionally bind address encoding, token decimal conversion, destination account requirements, and distinct wallet adapters. Chainlink's current CCIP architecture documentation includes EVM contracts plus Solana programs, Aptos modules, Move modules, and TON interfaces; its mainnet directory listed 77 networks on 2026-08-31. This establishes breadth, not suitability for every lane or asset. Sources: [CCIP architecture](https://docs.chain.link/ccip/concepts/architecture), [CCIP mainnet directory](https://docs.chain.link/ccip/directory/mainnet) (retrieved 2026-08-31).

Wormhole NTT supports EVM/SVM managers and transceivers, with burn/mint or lock/release flows, replay protection, rate limits, and off-chain delivery. NTT also contains owner/pauser/transceiver governance and may be upgradeable, so it does not inherit RealDEX's no-admin property. Sources: [NTT architecture](https://docs.wormhole.com/products/token-transfers/native-token-transfers/concepts/architecture/), [NTT security](https://wormhole.com/docs/products/token-transfers/native-token-transfers/concepts/security/) (retrieved 2026-08-31).

### non-EVM → non-EVM

Use IBC when both chains expose compatible on-chain light clients and token-transfer applications. IBC clients verify counterparty state on-chain; relayers transport packets and acknowledgements, while timeouts can trigger source-side recovery. ICS-20 specifies fungible token escrow/mint/burn handling between IBC-connected chains. Sources: [IBC overview](https://docs.cosmos.network/ibc/latest/ibc/overview), [IBC v2 packet lifecycle](https://docs.cosmos.network/evm/v0.4.x/documentation/concepts/ibc), [ICS-20](https://github.com/cosmos/ibc/blob/main/spec/app/ics-020-fungible-token-transfer/README.md) (retrieved 2026-08-31).

For pairs without compatible light clients, use a separately reviewed attestation/validator adapter or an HTLC atomic swap where both chains support compatible primitives. Wrapped Bitcoin-like representations are not treated as trustless merely because they are tokens.

## State machine

```text
configuring
  → quote-ready
  → awaiting-approval (when required)
  → awaiting-source-wallet
  → source-submitted
  → source-included
  → awaiting-proof
  → destination-submitted
  → destination-confirmed
```

Side states are `delayed`, `refundable`, `failed`, and `unknown`. Source finalization is never presented as destination completion. Refresh and retry must look up the existing message/transaction identifiers; they must not create a second source transfer.

## Manifest gate

A route is executable only when all of the following are true:

- status is `verified`;
- source and destination families match its route category;
- chain IDs and both endpoints are explicit;
- source and destination asset identities and representations are explicit;
- verification model, transfer mechanism, finality rules, and recovery mode are explicit;
- evidence URLs and a non-future review date exist;
- the installed adapter code recognizes the exact route revision;
- the quote fingerprint still matches the route and has not expired;
- bytecode/program/module identities and route availability were checked in the current release process.

Importing JSON into the UI is inspection only. A manifest cannot install executable adapter code or grant signing permission.

## Protocol observations from primary sources

- Hyperlane exposes per-application Interchain Security Modules and replay-protected message IDs. Its permissionless relayer delivers messages and can be self-run, but common validator-based security still depends on the chosen validator set and off-chain agents. Sources: [protocol overview](https://docs.hyperlane.xyz/docs/protocol/protocol-overview), [Mailbox](https://docs.hyperlane.xyz/docs/protocol/core/mailbox), [agents](https://docs.hyperlane.xyz/docs/operate/overview-agents) (retrieved 2026-08-31).
- Wormhole NTT managers collect threshold attestations from transceivers, enforce replay protection and rate limits, and use an off-chain relayer or manual delivery. Its documented governance differs from RealDEX's immutable pool contracts. Source: [NTT architecture](https://docs.wormhole.com/products/token-transfers/native-token-transfers/concepts/architecture/) (retrieved 2026-08-31).
- IBC provides on-chain light clients, packet receipts, acknowledgements, and timeout handling. Relaying is still required for liveness. Source: [IBC overview](https://docs.cosmos.network/ibc/latest/ibc/overview) (retrieved 2026-08-31).
- CCIP supports token and message routes across heterogeneous execution environments, but each live lane/token must be checked in the current directory. Sources: [CCIP architecture](https://docs.chain.link/ccip/concepts/architecture), [CCIP directory](https://docs.chain.link/ccip/directory/mainnet) (retrieved 2026-08-31).

## Unknowns that block further routes and mainnet

- Which exact assets are native, canonical-wrapped, or bridge-wrapped on each chain.
- Whether RealDEX may depend on third-party guardian/oracle/validator governance.
- Whether an issuer-controlled burn/mint model is acceptable; it requires persistent authority on each chain.
- Required transfer limits, finality thresholds, fee currency, timeout, refund, and incident policy.
- Which non-EVM wallet families must be supported first.
- Jurisdiction-specific consequences of distributing a cross-chain asset-transfer interface.

Until these are decided and verified, only the built-in Noble Testnet↔Osmosis Testnet route may request wallet signatures. The Base Sepolia-dependent CCTP routes are installed for inspection and historical recovery but paused by the live-code release gate. All other routes and every mainnet route remain disabled. The IBC UI keeps every single-REST acknowledgement outcome at non-terminal `destination-observed`; independent proof verification, funded-wallet recovery exercises, and a separately approved release gate are required before any public-network route may claim destination confirmation or terminal failure.
