# Real DEX public-testnet release gate

Status: read-only Base Sepolia release planning and deployment-evidence verification implemented. No public deployment has been performed.

## Why this gate exists

Contract deployment and initial liquidity are separate R3 actions. Deployment spends gas and creates an immutable public execution target; liquidity moves assets and creates a market. RealDEX does not combine them, does not run either action automatically, and does not accept a wallet secret in a release manifest.

The first reviewed public-network lane is Base Sepolia (`eip155:84532`). Base documents chain ID `84532` as its public Sepolia testnet. Mainnet chain ID `8453`, every other chain, and any manifest claiming `environment: mainnet` fail closed. Source: [Base network documentation](https://docs.base.org/base-chain/quickstart/connecting-to-base) (retrieved 2026-09-01).

## Pre-deployment plan

`npm run release:plan:base-sepolia` performs no network request and no signing. It prints a design-gated plan that binds:

- the three RealDEX v1 Solidity contracts, whose versioned artifact names remain `LocalSwapFactory`, `LocalSwapPool`, and `LocalSwapRouter`;
- compiler version and optimizer runs;
- `contracts/test/MockERC20.sol`, the test-only AMBR/JADE implementation;
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.node-version`, and Hardhat configuration;
- the release-plan generator itself;
- the v0.1 profile verifier/reader and existing deployment verifier/JSON-RPC reader;
- the frontend-pinned Factory and Router runtime hashes;
- a deterministic SHA-256 source-bundle identity;
- the exact Base Sepolia CAIP-2 identity;
- required evidence and prohibited actions.

The release ID derives from the bundle hash rather than a mutable date. A changed listed source, compiler configuration, dependency lock or policy, runtime version, generator, or pinned runtime identity therefore creates a different release intent. Paths are sorted deterministically and each UTF-8 input is length-framed before hashing. Missing or empty inputs fail closed; identity metadata is parsed from the exact same read that enters the digest. This binds the explicitly listed release inputs, not every frontend file, and is not evidence of deployment, provenance authentication, reproducible frontend output, or a security audit. `npm run test:release-plan` exercises these boundaries.

The code identity file additionally pins the deployed MockERC20 runtime with immutable decimals `18`. A local Hardhat test compares actual AMBR/JADE fixture bytecode to that pin and rejects a six-decimal fixture. Token names/symbols live in storage and therefore need separate metadata checks; a matching runtime alone does not prove the token is AMBR or JADE.

## Fixed v0.1 profile verification

`src/release/v01-profile.ts` provides the read-only prerequisite for the fixed pair. The default `src/main.tsx` now renders `src/v01/V01App.tsx`; `src/v01/runtime.ts` applies that prerequisite to connection, quotes and each approval/swap envelope. The original generic `App.tsx` is preserved behind the localhost development-only `experimental.html`, not shipped as a default production entry. Local integration is not public-testnet acceptance.

- Input schema `realdex.v01-profile.v1`: the existing full deployment manifest, one exact pool address/runtime hash, and AMBR/JADE addresses. Names, symbols and decimals are fixed by implementation, not accepted as arbitrary input configuration.
- A separately reviewed build pin binds the release ID, source bundle digest and canonical entire-profile fingerprint. No pin is bundled yet. Null/mismatched pins fail before network calls. Computing a fingerprint is a planning operation, not approval; production must not generate its trusted pin from an arbitrary imported file or localStorage value.
- The same two to four readers rerun the existing Factory **and Router** deployment verification, check the pool's Factory mapping/origin/sorted token pair and exact code, and require both tokens to have the compiled 18-decimal runtime plus exact `Demo Amber`/`AMBR` and `Demo Jade`/`JADE` metadata. Every reader must match; one wrong or failed reader rejects the result. Pool runtime includes constructor immutables, so its exact approved deployed hash is supplied by the separately pinned profile and cross-checked against the verified Factory's pool mapping.
- The public reader factory enforces the existing distinct public HTTPS hosts, omitted credentials/referrer, bounded responses and timeout. It adds ABI-specific `eth_call` reads for pool mapping, token metadata and pool identity. No connection, signing, broadcast, mint or liquidity method exists. Distinct hostnames are not proof of independent RPC operators; operator review remains required.
- Input data and reader method references are captured before asynchronous work. Unknown fields, accessors, cycles/non-JSON objects, duplicate/zero targets and stale selection callbacks reject. Caller-created or copied verification receipts are not accepted: results are frozen and registered in this module instance.
- Evidence expires 60 seconds after verification starts; slow verification, backward/invalid clocks and explicit invalidation reject. Exactly two route descriptors are derived, one per direction, with the fixed pool and injected EIP-1193 capability only. `assertV01Route` rejects descriptor changes. This does not prove MetaMask identity or grant wallet permission.
- `verifyV01Eoa` observes exact empty account code on the same readers, rechecks chain and context, and rejects contract/delegated/malformed code. It is read-only evidence about observed account state, not a signature or guarantee against later changes.

Connection is a separate permission step; approvals leave an allowance and swaps move assets irreversibly. The integration checks the current profile and exact wallet/account context before connection, quote and each approval/swap request, invalidates on selection/endpoint/account changes, preserves the existing durable duplicate/recovery guards, and binds the signed transaction's sender explicitly. An expired profile requires a new review, never automatic resubmission. Profile verification alone never authorizes any of these actions.

The MetaMask compatibility filter accepts explicitly selected EIP-6963 announcements with `io.metamask` and required events. These fields are self-reported, not cryptographic extension authentication; the user must verify the installed extension. See [EIP-6963 security considerations](https://eips.ethereum.org/EIPS/eip-6963). The wallet wrapper allows only the quote-bound zero-native-value exact approval or direct swap; changed sender, calldata, target, chain or unsupported transaction fields are rejected before the wallet send request. Token balance, swap allowance and remaining L2/L1/operator fee budgets are rechecked. The displayed type-2 gas/fee/nonce fields are forwarded exactly, with no state override in the final simulation. Missing fee observations stop quoting. These budgets are not a guarantee of final fees, a fee quorum or real-wallet acceptance; see [the fee contract and evidence](V01_FEES.md).

An origin-wide Web Lock and `realdex:v01-active-operation:v1` slot retain one unresolved operation across both directions and fresh quotes. Persistence is checked by exact readback before adapter execution. A possible send without a hash remains blocked for reconciliation, not reset or retried. After a terminal record, the separate close action freshly reads its receipt and requires at least two confirmations. Current recovery uses one configured RPC reader, not a two-reader finality proof; two confirmations are an application policy, not a finality guarantee. Full injected-failure/reload and authorized public-wallet recovery acceptance remain outstanding.

The release planner also binds the default entry, v0.1 UI/runtime/operation guard and CSS. Its explicit list is still not a complete frontend/dependency snapshot. `reviewed-profile.ts` is a separately reviewed post-deployment configuration artifact and is deliberately excluded from that pre-deployment digest to avoid a self-reference through its release pin. Before acceptance, record both the exact reviewed configuration and final built frontend identity. The shipped configuration is currently `null`; never replace it with fixtures or derive approval from imported data.

## Post-deployment evidence

`src/release/evm-public-testnet.ts` accepts only the strict `realdex.evm-public-testnet-deployment.v1` schema. The evidence must contain:

- the exact release and Base Sepolia identity;
- the source-bundle SHA-256 and pinned compiler/runtime identities;
- a public deployer address;
- distinct Factory and Router addresses, deployment transaction hashes, blocks, and runtime hashes;
- at least two distinct HTTPS evidence URLs;
- no unknown fields, including private-key or mnemonic fields.

Structural acceptance is not on-chain verification. The Release screen can create two browser-side readers from public HTTPS RPC URLs on distinct hosts. The URLs are not persisted, requests omit browser credentials and referrer data, each request has an eight-second timeout, and only `eth_chainId`, `eth_blockNumber`, `eth_getCode`, and `eth_getTransactionReceipt` are called. URL credentials, query parameters, fragments, localhost, private-network IPs, and same-host pairs are rejected. Operators must use non-secret public endpoints; RealDEX does not accept or store provider API credentials in this flow.

Verification requires two to four independently identified RPC readers. Every reader must report:

1. chain ID `84532`;
2. a head at or after both deployment blocks;
3. successful receipts whose contract addresses and blocks exactly match the manifest;
4. Factory and Router runtime bytecode hashing to the identities pinned by this build.

Any wrong chain, lagging reader, timeout, malformed JSON-RPC response, missing receipt, failed receipt, address mismatch, changed bytecode, duplicated reader identity, same-host endpoint pair, or divergent observation rejects the release. Changing the manifest or either endpoint invalidates an in-flight or completed page result, so a late response cannot certify different inputs. Even a verified result remains an inspection receipt and does not install an executable route. The UI deliberately exposes no Deploy, Add liquidity, Publish, or Mainnet action.

## Human authorization boundary

Passing the read-only gate does not authorize deployment. A later deployment turn requires explicit user authorization for the exact release ID and Base Sepolia network. It must use a disposable testnet-only account under user control, followed by receipt capture and two-reader verification. Initial liquidity remains a second explicit action after deployment verification.

Mainnet requires a new decision after independent contract review, fuzz/invariant and adversarial-token coverage, a funded-wallet public-testnet exercise, monitoring and incident procedures, verified source publication, and jurisdiction-specific review. Testnet readiness never inherits into mainnet readiness.
