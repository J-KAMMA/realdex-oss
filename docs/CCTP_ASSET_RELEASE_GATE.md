# CCTP asset release gate

Status: design gate installed on 2026-09-02. It cannot enable signing, submission, or execution.

## Purpose

An RPC quorum proves only what two readers currently report. It does not prove that restored bytecode was independently rebuilt from Circle's reviewed source, that the reviewer is trusted, or that the user approved reopening value movement. RealDEX therefore keeps those decisions separate.

1. `cctp-asset-release.ts` observes Base Sepolia chain/head, the documented USDC proxy, Circle's Zeppelinos implementation slot, implementation runtime, and strict ERC-20 metadata through two pinned public RPC hosts.
2. A reviewer source descriptor names one EIP-191 signer and the exact Base Sepolia USDC CAIP-19 identity. Its cryptographic fingerprint must be pinned separately before a manifest is accepted.
3. A signed release manifest binds that source fingerprint, the exact fresh observation fingerprint, both reader identities, minimum observed block, proxy and implementation hashes, Circle repository commit, Solidity compiler, optimizer settings, the full source-tree hash, source-file hashes, linked `SignatureChecker` address and runtime hash, verification mode, verification-artifact hash, revision, expiry, recommendation, and evidence URLs. The artifact JSON itself is a required verification input; a caller cannot supply only a claimed hash.
4. Verification returns `verified-design-gate` with execution, signing, and submission all false. `explicitUserReleaseRequired` remains true.
5. Enabling a route remains a separate reviewed source change and requires the user's explicit approval. A manifest must never mutate the runtime gate by itself.

## Required invariants

- The reviewer source fingerprint comes from a separately pinned descriptor; supplying a self-signed descriptor and manifest together is not trust establishment.
- The observation is no older than 24 hours and the manifest is valid for no more than seven days.
- The manifest cannot predate its observation.
- Both observations contain the same proxy hash, implementation address and hash, `USDC` name and symbol, and six decimals, with no more than twelve blocks of head divergence.
- The reviewed repository is exactly `https://github.com/circlefin/stablecoin-evm`; compiler and optimizer fields are fixed to the official proxy artifact settings currently under review.
- The current generator performs Circle's documented `partial-runtime` comparison: it removes Solidity CBOR metadata and requires the remaining proxy, implementation, and linked `SignatureChecker` runtimes to match. It records `metadataVerified: false`; this is not full bytecode identity.
- The generator accepts only the exact Circle origin, a 40-character commit, a clean tracked tree, Solidity `0.6.12`, optimizer 10,000,000, two agreeing Base Sepolia readers, and a newly created output file. It never enables execution, signing, or submission.
- Revisions are monotonic. Rollback and a different payload at the same revision are rejected.
- Revalidation repeats the signature, expiry, pinned-source, observation, and monotonic-head checks and rejects any mutation of disabled authority flags.
- `cctp-source-bytecode-verification.ts` applies exact-key validation to the artifact and deterministically derives the same canonical SHA-256 emitted by the generator. Repository, compiler, source tree, three contract records, two reader IDs, deployed addresses, observed runtime hashes, safe authority flags, and `metadataVerified: false` must all bind to the signed review and fresh asset observation.
- The verified review retains the normalized artifact and its derived SHA-256. Revalidation checks both again, so replacing the nested artifact or only its recorded hash fails closed.

## Current missing release inputs

No production reviewer source fingerprint, signed production manifest, full-metadata verification artifact, or user release approval is installed. A locally reproduced partial-runtime artifact alone is insufficient to release the route. All Base-dependent CCTP routes therefore remain disabled before wallet connection or quote retrieval. Historical finality refresh remains read-only.

## Reproducible partial-runtime artifact

Use a clean checkout of Circle's official repository with its locked dependencies installed. The output path must not already exist:

```powershell
npm run verify:cctp-asset -- --repo C:\path\to\stablecoin-evm --output C:\safe\new\cctp-verification.json
```

The generator compiles from the checkout itself, refuses a forked origin or tracked modifications, extracts the deployed `SignatureChecker` link from observed implementation bytecode, and reads the asset through two fixed Base Sepolia RPC endpoints. Successful output still contains `executionEnabled: false`, `signingEnabled: false`, `submissionEnabled: false`, `explicitUserReleaseRequired: true`, and `metadataVerified: false`. A historical reproduced fixture is retained under `test/fixtures/` to ensure the application validator derives the exact generator hash and rejects schema or authority drift.

## Deployment metadata reproduction

The deployed Solidity CBOR records IPFS multihashes and compiler `0.6.12`. Its source unit names use Circle's historical deployment checkout prefix, so compiling the current repository paths cannot reproduce the metadata even when runtime logic matches. The deployment report reconstructs those source unit names from Circle's public historical commit and keeps this separate from release authority:

```powershell
npm run verify:cctp-deployment-metadata -- --repo C:\path\to\stablecoin-evm-with-history --output C:\safe\new\cctp-deployment-metadata.json
```

Historical compiler-linked read-only result on 2026-09-02 (superseded by the post-compilation-link result below):

- Circle deployment source commit: `a1b5455f1779d8840b6b53cc562f5cc3d0a4875d`.
- `FiatTokenProxy`: full runtime and metadata match.
- linked `SignatureChecker`: full runtime and metadata match.
- `FiatTokenV2_2` implementation: all 23 pinned Circle/OpenZeppelin sources, compiler settings, linked library, runtime length, and metadata-stripped runtime match; the IPFS metadata hash does not match.
- The implementation's on-chain CID content was unavailable from the probed trustless gateways. Sourcify's submitted partial-match metadata is exactly reproduced but has a different CID, so it is evidence for partial runtime only and is not substituted for the unavailable on-chain content.
- Generated status is `verified-mixed-runtime`; `metadataVerified`, execution, signing, submission, and release eligibility remain false.

## Post-compilation linking reproduction

The follow-up v2 report compiles the implementation with an empty `settings.libraries` and then links only the compiler-declared `SignatureChecker` PUSH20 placeholders (20 bytes at offsets 18391 and 20106). It rejects missing, overlapping, unexpected, out-of-bounds or non-placeholder references and never copies metadata from an RPC.

All three contracts now reproduce byte-for-byte, including metadata, on both Base Sepolia readers. The implementation runtime Keccak is `0x1254951e5483b882fd5def9452f58fe786eb3380c0bf9bb2744fa21a0a97a16c`. Its generated metadata SHA-256 is `bd27843f7f59f04bcc607c7d89e60b6c17c845f6477b32e8084f05b9f2dff091`, and the generated CID equals the on-chain `QmUTXaoQGszf6ciXvSucGXQJckyKJHd8cDbxpxrKNeVUGK`. The v2 report includes the exact generated metadata JSON and link references for independent reproduction.

The former IPFS availability blocker is no longer needed for binary reproduction. A compiler-linked build includes the library address in metadata; a post-compilation link preserves the original empty library map. This explains the former partial match without replacing any on-chain bytes. See [Solidity library linking](https://docs.soliditylang.org/en/v0.7.6/using-the-compiler.html#library-linking).

`verified-full-runtime` and `metadataVerified: true` describe binary reproduction only. `releaseEligible`, execution, signing, and submission remain false. This report is not a security audit, proof of bridge correctness, production reviewer approval, or permission to enable routes. Existing signed-review v1 inputs remain unchanged.

## Signed metadata supplement

`cctp-deployment-metadata-review.ts` connects the v2 full-runtime report to a verified v1 asset review through a separate `realdex.signed-cctp-metadata-review.v1` signature. It does not reinterpret the old partial-runtime signature as approval of new evidence.

- The application profile pins the reproduced deployment commit, source-set hashes, exact metadata JSON hashes, runtime and logic hashes, CBOR and CID pairs, library address and link offsets for all three contracts. This profile covers only the identified Base Sepolia deployment, not arbitrary upgrades or chains.
- The supplement signs the entire canonical report SHA-256, parent release payload hash, externally pinned reviewer source fingerprint, issue time and expiry. It uses a distinct signing-domain prefix. Its signer must match the independently pinned parent reviewer, and the original review signature and artifact are revalidated before acceptance.
- The report must be at most 24 hours old and precede the supplement. The supplement must not predate the parent review or outlive it. Runtime identities and both reader IDs must match the parent observation; the report minimum block must not exceed the parent's and may lag it by at most 12 blocks.
- Revalidation recomputes both signatures and hashes and rejects modified evidence, result hashes, or authority flags. Callers must supply the externally trusted source fingerprint and a parent review validated against their current revision head; the supplement does not replace durable anti-rollback head storage.
- A successful result is `verified-metadata-supplement`, with execution, signing, submission and release eligibility all false. It is a local evidence-validation API, not an enabled bridge, an audit, an automatic signature request or a UI release control. Production reviewer signatures and explicit user release remain outstanding.

## Read-only review panel

The disabled CCTP route now exposes **Review signed evidence** below its two-RPC identity check. The user must independently enter the trusted reviewer fingerprint and select a public JSON bundle (maximum 256,000 UTF-8 bytes). It contains exactly five top-level fields: `source`, `releaseManifest`, `verificationArtifact`, `metadataReview`, and `deploymentReport`. These are respectively the reviewer descriptor, original signed asset review, its original bytecode artifact, signed metadata supplement, and full-runtime report. The file cannot supply the current observation or automatically set the trusted fingerprint.

The local verification button passes the latest identity evidence through both signature-verification APIs. File selection is not verification. Editing the fingerprint, replacing the file, refreshing the identity or changing routes invalidates the previous result; overlapping file reads cannot replace a newer selection. The result expires at the earliest parent/supplement expiry or evidence-age limit. Errors are generic and never echo uploaded data or raw verifier errors.

Authenticated parent revisions are remembered for the lifetime of this panel, even when the corresponding metadata supplement is rejected. This is not durable anti-rollback storage. No file data is uploaded or persisted to browser storage, no wallet is connected, and no signature, quote, approval, burn or mint is requested. The existing route remains disabled after a successful review.

`scripts/qaCctpReviewPanel.mjs` checks the actual local app with an isolated Chrome profile, rejects non-loopback HTTP requests, and captures error/empty-state layouts at 1280, 390 and 320 pixels plus 200% text scaling. Cryptographic acceptance is covered by the policy tests; UI tests cover verification wiring, prerequisites, file-size/schema rejection, file-read races, result invalidation, expiry and in-panel revision retention. Browser captures do not certify live reviewer approval or bridge execution.

Primary references: [Circle USDC address table](https://developers.circle.com/stablecoins/usdc-contract-addresses), [Circle stablecoin EVM repository](https://github.com/circlefin/stablecoin-evm), [proxy design](https://github.com/circlefin/stablecoin-evm/blob/master/doc/tokendesign.md), [implementation slot source](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/upgradeability/UpgradeabilityProxy.sol), and [Circle bytecode-verification guide](https://github.com/circlefin/stablecoin-evm/blob/master/doc/bytecode_verification.md).
