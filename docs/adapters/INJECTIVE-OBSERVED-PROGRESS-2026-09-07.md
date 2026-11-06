# INJ-01: cumulative spot-order observation reconciliation

## Base and scope

Issue #16 continuation after CI repair #17 / PR #18.
Base commit: `f6aacbdbfaceab7c3afaed0ebc4446881936aa26`.
Base tree: `b8c3728ed5012bdfcb70451f24ec6e360809f5b7`.

This is a fresh implementation against the available GitHub source, not restoration
of the previous conversation's unpushed implementation or its reported tests.
Only the Injective unsigned-order helper, declarations, tests and this document
change. Existing preparation, protobuf, cancellation and stateless `orderProgress`
behavior is retained. No RPC, account balances, signer, wallet persistence,
transaction broadcast or automatic retry is introduced.

## API

```js
import {reconcileInjectiveOrderObservation} from './node/external/injective-orders.mjs';

// plan comes from prepareInjectiveLimitOrder, not an arbitrary API response.
const observation = {
  planSha256: plan.planSha256,
  clientOrderId: plan.clientOrderId,
  orderHash: '0x' + 'ab'.repeat(32), // illustrative, not a real venue order
  revision: '1',                  // caller-owned local sequence, NOT block height
  filledBaseAtomic: '0',         // cumulative base atoms, NOT this-event quantity
  status: 'open'
};
const first = reconcileInjectiveOrderObservation(plan, observation);
const duplicate = reconcileInjectiveOrderObservation(plan, observation, first.state);
// duplicate.duplicate === true; state is a fresh copy and does not mutate first.state.
```

The caller must map venue messages into cumulative observations in one ordered
stream. The library neither fetches them nor invents their revisions. Observations
require the exact six fields shown. Revision is a canonical unsigned decimal
string from 1 through 2^64-1. Order hash is a nonzero lowercase 32-byte hex value.
Numbers used for quantities and revisions are never coerced through floating point.

## Rules

The exact plan self-hash and client ID bind an observation to its plan; reusing
only a client ID is insufficient because two prepared quantities can share that
ID. The original plan's JSON field order participates in its existing plan hash;
ordinary JSON round trips preserve it, arbitrary field reordering does not.

A new revision must not decrease, cumulative fill must not decrease, and reported
order hash must never change. Same revision and identical normalized observation
is an idempotent duplicate; same revision with different contents is rejected.
Revision gaps are allowed: sequence numbers do not prove delivery completeness.

An open or cancellation-pending report can advance to a complete fill; this keeps
fills racing with a cancel. A reported terminal state can only repeat with the
same terminal status and quantity. A later contradictory report is rejected for
manual/source reconciliation, not silently rewritten. Starting again with no
previous state does not preserve history and is not a safe persistence/recovery
mechanism. The caller is responsible for retaining and protecting its prior state.

`unknown` is never automatically promoted to `filled`, including when reported
cumulative quantity equals the total. A cancelled report retains earlier fills
and remaining quantity but cannot release any reservation.

## Security boundary and limitations

Every state has these false flags: observationAuthenticated, settlementVerified,
reservationMayBeReleased, automaticRetryAllowed, signingEnabled, broadcastEnabled,
and executable. `reportedTerminal` means only what the report claims. Local
self-check SHA-256 hashes detect inconsistent/accidentally changed data; they are
NOT MACs, signatures, blockchain proofs, or authorization. Anyone can recompute
these hashes. A malicious party able to replace both plan/history and their hashes
can fabricate a consistent history. No honesty, finality or reorg safety is proven.

Only bounded plain JSON data is accepted, with depth/node/string/key limits and
no symbol properties, accessors, hidden data properties, toJSON functions, foreign
prototypes or sparse arrays. The boundary does not sandbox JavaScript Proxy traps
or hostile code running inside the same process. Parse untrusted wire JSON before
calling it; this is not an arbitrary-JavaScript object isolation boundary.

Previous state's derived fields and false permission flags are recomputed and
checked, rather than trusting a supplied state hash alone. This verifies local
consistency, not prior history authenticity or durable write-before-send storage.

## Verification

```sh
node --test --test-reporter=tap node/external/test/injective-orders.test.mjs
node app/ci.mjs --suite external --jobs 1 --output /new/path/external
node app/ci.mjs --suite all --jobs 3 --output /new/path/source-ci
```

Initial focused run: 94 named tests passed on Node 22.16.0, no failures or skips.
This includes the original independent Python Decimal/protobuf checks and the
new 512-observation / 64-duplicate sequence. Sequence operations are not counted
as extra named tests. A separate Python integer calculation computes expected
cumulative fills and remaining quantities from total and index, not from the
helper's own result. The evidence report/PR records final exact-tree reruns.

Tests cover plan/ID/hash substitution, stale/conflicting/wrapped revisions,
quantities beyond the JavaScript safe-integer limit, overfill, terminal conflicts,
rehash of tampered derived fields, forbidden authority flags, mutation isolation,
JSON round trips, accessors and bounded-input rejection. These remain offline
unit/differential tests, not live Injective venue or settlement acceptance.
