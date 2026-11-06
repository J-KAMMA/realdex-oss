# E2E03 — included failure, fee/sequence accounting, restart and next approval

This is a **reference-only validation addition** to E2E02 commit
`554e8c6418b791d697f7e6a5f0010d70c26ee72a` (tree
`7c858ba38dae56146b659993881013474ae4380c`). Product reference is INJ12
`a0bb48445bc4d626806697475fc7965485b1a9ac`. The actual INJ13 checkpoint source
is unavailable. This is NOT a successor or substitute for it. Do not open an
INJ13/checkpoint-protected/user Vault with this reference. No product wallet,
transport, signer, format, CI timeout or release gate is changed.

## Real scenario, not a synthetic failure reply

Two separate disposable owners run on the pinned official local Injective node.
Each places a one-unit sell using the existing owner API. The owner signs its
cancel after successful preflight. Only the test child's network boundary is
paused, AFTER the unchanged product has persisted SUBMISSION_STARTING. A different
actor fully buys the order, leaving the cancelling owner's sequence untouched.
Then the exact signed cancel is sent once. The node accepts CheckTx (code0) but
includes the transaction with exchange code19, a result observed for this pinned
missing-order scenario. The expected code is fixed; unrelated failures cannot
make this scenario pass. No arbitrary fake result is substituted for the RPC.

Mode `response` returns the real CheckTx response and restarts gracefully with the
same storage directory before reconciliation. Mode `kill-before-record` SIGKILLs
the owner after actual failure inclusion but before the engine receives/saves a
response. The latter MUST leave its original writer.lock intact. A separate
process must be refused at that same directory. Only after confirming this does
the fixture copy the exact latest ciphertext into a new private temporary home.
This is a **test-only restoration model, NOT a production stale-lock repair or
checkpoint restoration procedure**. No lock is removed to open the old home.

Both modes reject the former authorization token and a repeated submit. Before
receipt reconciliation, a new approval is blocked by the unresolved transaction.
After reconciliation the old record is `reported-reverted`, with received:true,
reason INCLUDED_FAILURE, matching hash/height/code, no actionEffect or retirement,
and automaticRetry/finalityProven false. The failed cancel does not change base,
quote or exchange assets, but its fee500000000000000 INJ atoms and one sequence
number remain consumed. Reading terminal status again makes zero network requests
and zero storage writes. A second graceful restart preserves the failure record.
Only a **fresh owner-approved** 0.25-unit deposit is sent; it succeeds using the
next sequence. This is not re-signing/retrying the cancelled order automatically.

One run contains two cases, 22 fixed checks each, one SIGKILL, six owner submissions
(two sells, two failed cancels, two new deposits), and two counterparty buys.
Genesis/market bootstrap transactions are separate. Check counts are NOT numbers
of independent unit tests. Evidence has no private keys, tokens, ciphertext or raw
node homes. Public hashes and aggregate/atomic accounting only are retained.

## Running on the exact source

Provision the original archive with the unchanged verifier:

```sh
python3 -I integration/injective/provision.py --archive /existing/linux-amd64.zip \
  --output /new/private/runtime
node --test --test-reporter=tap integration/owner-e2e/test/failure-protocol.test.mjs \
  integration/owner-e2e/test/failure-host.test.mjs
node integration/owner-e2e/run-failure.mjs --runtime-dir /new/private/runtime \
  --output /new/evidence --expect-commit "$(git rev-parse HEAD)" \
  --expect-tree "$(git rev-parse HEAD^{tree})"
python3 -I integration/owner-e2e/check-failure-evidence.py --directory /new/evidence \
  --expect-commit "$(git rev-parse HEAD)" --expect-tree "$(git rev-parse HEAD^{tree})"
```

A clean, commit/tree-pinned checkout, outside-source fresh evidence directory,
Linux x86-64 and the pinned runtime files are mandatory. No public endpoint,
user-home option, arbitrary message, caller-selected kill PID, key import on
restore, automatic stale-lock removal or privileged policy modification exists.
The host must be launched in explicitly disposable mode by this scenario. The
node and both owner processes are cleaned up, including on failure.

Node checks and the independent Python checker reject missing/duplicate cases,
wrong trees, altered files/logs, inconsistent counts, code0 or another exchange
error, fees refunded on failure, sequence reuse, resend, substituted signatures,
wrong SIGKILL evidence, or an invented checkpoint/browser/production approval.
Python -O cannot disable these checks. Unit vectors are marked synthetic and are
not included as real-chain evidence.

## Limits and remaining work

A consistent receipt from one local node is not authenticated consensus or an
independent proof. The scenario does not certify public chains, OS isolation,
Windows/NFS/real power loss, native same-home lock recovery, actual INJ13
checkpoint compatibility, browser-DOM-to-chain execution, complete runtime/build
acceptance or an independent audit. The failure paths tested here may pass on this
reference while an unavailable later product differs. The verification addition
must be reviewed and rerun on the recovered product source before promotion.

Primary API/lifecycle references (background; actual behavior is asserted on the
pinned node, not inferred from these documents):
- https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html
- https://docs.cosmos.network/sdk/v0.47/learn/beginner/tx-lifecycle
