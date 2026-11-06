# INJ-09: signing and recovery stay bound to observed chain history

## Exact base, scope and reproduced defect

Base is local INJ-08 commit `0cde56d8877d9fce8638cfcd041e74ede4c9bd99`, tree
`90f98e2d65e05050b6279676adc38b5bdc3ebc4a`, distribution SHA-256
`08f3efacd6e12b044d7a1491517ee78748afb21c26aeb8a3e4c4b829208318c1`.
The actual INJ-08 ancestry uses INJ-07 Unsent-Recovery, NOT the separately named
INJ-07 Unsent-Expiry branch. No GitHub read/write or remote CI is used.

The unmodified owner engine rechecked chain ID, account, gas and action state,
but did not compare the original review block to the currently queried node,
except for a separate retired-history barrier. An isolated synthetic provider
changed the original block hash while retaining chain ID/account/counters. The
original owner API still signed and performed an initial send. The retained
baseline reproducer records that defect; its passing assertion is NOT a safety
pass or evidence that a public account was exploited.

This change adds read-only continuity checks to the product signature, first-send,
receipt reconciliation and unsent-retirement paths. Wallet KDF, key ownership,
signature codec, Vault schema, persistence primitives, operation permissions,
public-network restrictions and full acceptance/release gates are unchanged.
Shared safety-engine changes are explicitly in this local integration task's
scope, not a silent edit of another work lane or an independent audit.

## Existing encrypted history is the reference

The current review anchor is mandatory. For the same owner account, previous
signed reviews must have the same loopback origin, chain ID, account number,
address and public key. Every stored local checkpoint is considered for the
height floor and same-height contradictions. Actual network reads are bounded
to the current review anchor and the earliest/latest distinct retained anchors
(up to three per check); INJ-07 retirement checkpoints participate as well.
A received transaction's height also raises the nondecreasing height floor.

The selected node must return each requested historical height with the same
block hash and millisecond timestamp. Canonical hex or base64 block hashes and
the two existing REST header envelopes are accepted. Conflicting envelopes,
invalid dates/zero hashes/overflow heights, missing/pruned blocks, changed
origin/account identity or lower current height fail closed. There is no new
provider fallback, automatic pin reset or on-disk migration.

Checks run immediately before signature/persistence and before persisting the
first-send start state. Receipt checks surround node observations and post-state
reads. Reconciliation also requires a positive inclusion height after the review
anchor, no later than the observed latest head. An invalid response cannot mutate
either memory or encrypted history. Epoch/authorization guards are checked after
network awaits; lock interruption is not mistaken for success.

The signed record still becomes `broadcast-unknown` on disk BEFORE its one
permitted send. Unknown submissions remain unresolved. A continuity failure
cannot turn an unknown transaction into a safe retry or an unsent retirement.
Existing terminal records are returned as cached historical observations, not
newly authenticated results about the current node.

## Recovery behavior and compatibility

Return to the ORIGINAL node and its retained chain data to continue. Inspect
its identity and original checkpoint before retrying a read-only operation.
Do not delete transaction history, overwrite the Vault with an older backup,
change a URL to evade a pin, or assume that restarting a chain grants a fresh
transaction sequence. Explicit authenticated migration to another endpoint or
history is not implemented in INJ-09. A node must retain/query the selected old
blocks; pruning is not silently accepted.

The Vault data schema and record states are unchanged from INJ-08. Existing
valid INJ-08 histories can be read without migration. Older software will NOT
provide these new continuity checks, so byte-format compatibility is not a
security reason to downgrade. Whole-Vault rollback cannot be ruled out without
an externally retained newer checkpoint. History remains bounded to 64 records;
no compaction/deletion bypass is introduced.

## What this does not prove

Block-hash equality is a consistency observation of one selected node. The code
does not independently reconstruct header hashes, verify validator signatures,
verify Merkle state proofs, prove finality, or exclude a fork after all retained
checkpoints. A malicious node can repeat known hashes while fabricating other
state. Same-process hostile code and privileged filesystem attackers are outside
this boundary. All existing `chainStateAuthenticated`, `settlementVerified` and
production approval flags remain false. No public testnet/mainnet operation or
new signer authority is enabled.

## Reproduction

```sh
node --test --test-reporter=tap wallet/test/injective-continuity.test.mjs
node --test --test-reporter=tap app/test/local-completion-roadmap.test.mjs
REALDEX_INJECTIVE_DIRECTORY=/absolute/verified/runtime \
  node --test --test-reporter=tap integration/injective/OwnerContinuity.test.mjs
node app/ci.mjs --suite all --jobs 3 --output /new/path/source-ci
```

The integration suite uses the unchanged pinned official binary and creates two
fresh isolated nodes with identical chain IDs and disposable account keys but
different validator/genesis histories. A loopback-only forwarding proxy switches
between them without rewriting block/account/simulation responses. It proves
approval rejection, first-send rejection, unknown-result protection, encrypted
restart, sequence-aligned replacement rejection and unsent-retirement rejection.
Returning to the original node permits one deposit and one withdrawal; exact
balances and two fees agree. One B-only sequence-alignment transaction is test
setup, not a wallet submission or user-fund action.

A separate local roadmap in `plans/LOCAL-COMPLETION-2026-09-07.md` distinguishes
limited-release completion from the original full-project scope. Test totals and
final commit/tree are recorded in the delivery evidence, not inferred from this
document's presence. Existing UI tests use synthetic APIs; they are not evidence
of an actual browser-to-chain end-to-end pass.
