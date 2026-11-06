# E2E04: concurrent owner requests and emergency-lock boundaries

## Source and non-goals

This is validation added to the exact E2E03 reference commit
`4b9fb272af9a9c360440e105419644f6af48eb2f`, tree
`ce332c96d104f72def879cdba927f007a63f8bb2`, which derives from INJ12.
INJ13's actual checkpoint source is unavailable. This is not its successor or a
replacement and MUST NOT open an INJ13/checkpoint-protected or user-funded Vault.
No product wallet, signer, server, persistence format, dependency pin, timeout,
public network permission or release gate is changed. Only the validation host,
scenario/evidence checker, tests and the existing addon test registration change.

## Five controlled interleavings, one real server per owner

The runner provisions no new version. The existing pinned Injective node starts
with fresh fictitious genesis balances and test-only local keys. The unchanged
WalletServer/Vault handles requests from multiple real HTTP clients. Barriers
pause one exact network point and preserve the actual upstream response. They do
not override busy flags, authorize callbacks, signed bytes or persistence logic.

1. Double click: one approval is paused at simulation; eight more approvals of
   the same intent must fail with NON_EVM_OPERATION_BUSY, not another error.
   Exactly one signed record is saved after release, with zero submissions. A
   later repeat fails NON_EVM_REQUEST_NOT_PENDING. During first submit, the saved
   SUBMISSION_STARTING record is required before the test boundary is reached;
   eight repeat submits and one reconcile must be rejected with no query/write.
   Only the first confirmed submit reaches the node once.
2. Lock during approval simulation: emergency lock returns immediately; releasing
   the real response cannot sign or write anything. Ciphertext is unchanged. A
   subsequent unlock restores no signed record and the old approval is invalid.
3. Lock during pre-submit simulation: zero submissions and no mutation of the
   saved signed record. After unlocking, a fresh explicit tx-hash confirmation
   can submit the same still-unexpired signed transaction once. No auto-submit.
4. Lock after node acceptance: the transaction is actually included while its
   response is withheld. Locking prevents the result being saved, NOT the chain
   transaction. The persisted state remains broadcast-unknown/SUBMISSION_STARTING.
   Graceful restart reopens the SAME home without a copied Vault or deleted lock,
   rejects the old token and resubmission, and reconciles by the saved hash.
5. HTTP client disconnect during approval: the client AbortSignal is triggered
   only after the server is processing the real approval. The authorized server
   operation still saves one signed record; disconnection alone is not revocation.
   It sends zero transactions. History retrieves that record and a separate
   explicit tx-hash confirmation is required before the single submission.

Each submitted transaction is a 0.25-unit self-deposit. Independent before/after
bank, exchange, gas and sequence accounting must show exactly one transaction
(or none for lock-during-approval). Four total owner submissions. No counterparty
transactions beyond the node's separately recorded bootstrap are needed.
Terminal reconciliation must perform zero additional network calls or writes.

## Running the pinned reference

```sh
node --test --test-reporter=tap integration/owner-e2e/test/concurrency-protocol.test.mjs \
  integration/owner-e2e/test/concurrency-host.test.mjs
python3 -I integration/injective/provision.py --archive /existing/linux-amd64.zip \
  --output /new/private/runtime
node integration/owner-e2e/run-concurrency.mjs --runtime-dir /new/private/runtime \
  --output /new/evidence --expect-commit "$(git rev-parse HEAD)" \
  --expect-tree "$(git rev-parse HEAD^{tree})"
python3 -I integration/owner-e2e/check-concurrency-evidence.py \
  --directory /new/evidence --expect-commit "$(git rev-parse HEAD)" \
  --expect-tree "$(git rev-parse HEAD^{tree})"
```

A clean checkout, exact pins and a new output directory outside source are
mandatory. The CLI has no user-home, key-import, remote-server, force-unlock,
arbitrary-gate-URL or production-mode option. The child only works with an explicit
disposable test marker and private randomly named directories under the OS temp
root. Capabilities/test secrets travel in process pipes; they are not evidence.

The independent Python checker validates file sets, duplicate JSON fields, source
snapshots, trace order, every case and integer accounting. Assertions are explicit
exceptions and still operate under python -O. Unit evidence vectors are synthetic,
not published as proof of runtime execution. All final evidence retains status,
identity, environment and raw outcomes; the 55 scenario checks are not 55 separately
named Node tests. Multiple repeated validations are not added to source test counts.

## Limits and user-facing semantics

The emergency lock is not an on-chain cancellation. Once network submission has
begun, the implementation must preserve uncertainty and forbid automatic resend;
the lock cannot recall data the node already received. An HTTP client's aborted
request is also not a revocation receipt. The tests establish these properties
for this reference only, with selected real interleavings, not all possible
concurrency schedules, independent Vault replicas or independent process writers.

The graceful same-home restart here is NOT a stale-lock repair after SIGKILL.
Existing E2E02/03 keep their stale-lock refusal and explicitly separate their
fixture-copy model. INJ13 checkpoint/restore integration, OS key isolation,
Windows/NFS/power loss, actual browser DOM end-to-end, public testnet/mainnet,
full build/runtime acceptance and independent security review remain unverified.
Do not interpret a passed self-hashed report as a cryptographic state proof.

Primary API references consulted (not runtime-result evidence):
- https://nodejs.org/download/release/v22.16.0/docs/api/globals.html#class-abortcontroller
- https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html
