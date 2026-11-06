# INJ-04: actual local Injective spot lifecycle

## Scope and fixed baseline

Base: PR25 commit `5dd9f5155f6a71ed09f380a7d58c8b6ec89d1c60`, tree
`2d62e0197fb92d194dbfa92d3c7adc8181f2f239`. Issue26 records this separate
integration scope. Existing CI, full acceptance, wallet key storage and signing
permissions are not changed. No main/import/predecessor refs are updated.

The new integration fixture starts a REAL Injective node from the official
v1.20.3-safeharbor.2 archive. It verifies the outer archive plus injectived and
libwasmvm bytes before execution. The pin names the full upstream commit and
release URL. The binary has not been independently rebuilt from source.

The node has a fresh genesis and generated validator/trader keys, loopback RPC,
REST and P2P listeners, no persistent peers or peer discovery, no JSON-RPC or
public RPC. Three diagnostic traders receive fictitious genesis coins. Keys and
chain data are confined to a newly created private temporary directory and
removed on teardown; trader secret buffers are overwritten. This is not certified
secure erasure or a production keystore. No user key import is supported.

## Real-node defects found and fixed

1. The gateway emits `grpc-metadata-x-cosmos-block-height`; the prior preflight
   only understood the unprefixed name. Either spelling now requires the exact
   requested height, and both must agree when present. No missing-header bypass.
2. Market tick/notional units on v1beta1 REST could not safely be assumed to be
   legacy atoms. The query now explicitly uses v2 human units and exactly scales
   them to the existing atom-format order/indexer representation.
3. Injective simulation reports the chain meter in `gas_wanted`, not the gas cap
   encoded in TxRaw. We keep the user gas/fee limits unchanged, require used gas
   within both the returned meter and user gas limit, and retain the user margin.

Old failing logs and new runtime receipts distinguish actual protocol findings
from the originally successful synthetic tests. Unit tests cover both height
spellings, conflict/missing metadata, v2/legacy unit confusion and gas meters.

## Tested lifecycle

The test launches a spot market via an actual v2 transaction. A fixture-only
validator is configured as the local exchange admin and explicitly cancels the
node's startup post-only mode using a real admin transaction. This avoids waiting
for the startup protection period; it does NOT disable matching/fund constraints
or introduce an admin into a public chain or the product wallet.

The existing preflight and legacy v1beta1 order bytes are then exercised against
this node. Incorrect ordinary-Cosmos SHA256 signatures are rejected; correct
Injective Keccak signatures generated only by the diagnostic fixture execute.
The scenario checks a 2-unit sell, a 0.5-unit opposing buy, the 1.5-unit remainder,
cancellation, retained 0.5-unit sale, exact buyer base credit and conservative quote
fee bounds. It also deposits/withdraws to a nondefault subaccount, rejects an
excess withdrawal, and checks a full 0.25-unit fill. A real loopback proxy drops
one successful broadcast response; lookup by the exact transaction hash finds the
included order without a second send, and that order is cancelled normally.

Actual on-chain order observations are fed into the existing journal, and a new
process reopens the saved head. Journal authenticity/settlement/retry flags remain
false. The submission-loss exercise validates the local transport scenario; it
is not a new automated wallet recovery implementation.

The diagnostic snapshot adapter reads actual v2 market/book data, converts it to
the current unsigned-order input schema, and explicitly records that no independent
indexer or book sequence is present. This is NOT a test of the public indexer.

## Reproduce

On Linux x86-64 with the repository Node version:

```sh
# Obtain the exact archive URL/size/hash specified in integration/injective/pin.json.
python3 -I integration/injective/provision.py \
  --archive /existing/linux-amd64.zip --output /new/injective-tools
REALDEX_INJECTIVE_DIRECTORY=/new/injective-tools \
REALDEX_INJECTIVE_EVIDENCE=/new/lifecycle.json \
  node --test --test-reporter=tap integration/injective/Lifecycle.test.mjs
```

Output paths must be new. The workflow runs this scenario on Node22.16.0 and
24.14.0 and retains only TAP, public diagnostic receipts, commit/tree and pin
identity. It never uploads keyring/home/chain folders. A separate job exports
exact tracked source and a Git bundle for interruption recovery.

There are21 named lifecycle subchecks plus one aggregate Node test (22 in TAP).
They are not added to the source-suite count. Evidence is marked passed only
after every subcheck completes; TAP/exit status must also pass, including teardown.

## Remaining boundaries

No production owner-signing or public broadcast route was added. The fixture's
signer handles only freshly generated local actors; it is not exported through
WalletServer or the owner UI. Public testnet order/fill/cancel/withdrawal, signer
integration, trusted/verified remote state, independent security review, OS key
protection and deployment remain separate unfinished product requirements.
Existing Stellar and smart-account full-verifier blockers remain; this new local
workflow does not redefine those gates or promote main/canonical status.

Primary sources inspected:
- InjectiveFoundation/injective-core release v1.20.3-safeharbor.2-1788352700,
  source de8a811d4c198b2723a52453cb6b61ee6c38b931; setup.sh and exchange v2 schema.
- The same source's injective-chain/crypto/ethsecp256k1/ethsecp256k1.go defines
  Keccak256(message) signing and accepts the compact signature with recovery byte.
- https://docs.injective.network/infra/join-a-network
