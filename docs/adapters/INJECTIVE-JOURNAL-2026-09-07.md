# INJ-02: restartable local order-observation journal

## Purpose and exact base

Issue #20 continues PR #19 at commit
`e523188a27b9dc4f2e29e2b8717424b391d1ffec`, tree
`a22a36c376a6f83c1cf61310a5706ff7a85dbadf`.
The parent delivery ZIP SHA-256 is
`27f53740e39d526077479b3b0306b9d052bb8f07edda77ad81526035c3db4fff`.

The existing pure reconciler checks one transition when supplied with prior state.
This module saves the original unsigned plan and all accepted cumulative
observations, then replays every transition when opening or updating the file.
It is a separate observation store, NOT shared wallet storage or write-before-send
transaction persistence. It cannot sign, broadcast, release funds or allow retries.

## Scope and prerequisites

Five new files: `node/external/injective-journal.mjs`, its `.d.mts`,
`node/external/test/injective-journal.test.mjs`, `node/spot-order-journal.mjs`, and
this document. The new paths are explicitly recorded in Issue #20 as an Injective
scope extension requiring integration review. `dev/workstreams.json` is not
silently broadened. Existing pure helpers, wallet state, signers, dependency pins,
CI profiles, original release metadata and earlier branches are unchanged.

Initial storage profile: Linux, a trusted local POSIX filesystem and cooperating
processes under the same owner. The target directory must be absolute, canonical,
new, and inside an existing owner-private directory. The module creates mode0700
directories and mode0600 files, rejects group/other permissions, symlink paths,
nonregular files and multiply linked data. No Windows/NFS/FUSE or power-loss
certification is claimed; non-Linux platforms explicitly reject storage use.
Checks are not a sandbox against privileged/same-UID hostile programs, malicious
mounts, JavaScript Proxy traps or filesystem/hardware lying about fsync.

Runtime data contains account/order observations; keep it outside Git and CI
artifacts. The CLI never fetches private keys, credentials, RPCs or venue events.
User-provided plan/observation files are read-only, bounded to64KiB/4KiB, reject
invalid UTF-8, duplicate JSON keys, unsupported flags and symlink file inputs.

## API

```js
import {
  createInjectiveObservationJournal,
  inspectInjectiveObservationJournal,
  appendInjectiveObservation
} from './node/external/injective-journal.mjs';

// plan is an unsigned plan from prepareInjectiveLimitOrder.
// firstObservation has the six fields required by PR19's reconciler.
const first = createInjectiveObservationJournal(directory, plan, firstObservation);
const reopened = inspectInjectiveObservationJournal(directory, {
  expectedHead: first.journalSha256
});
const next = appendInjectiveObservation(directory, nextObservation, {
  expectedHead: reopened.journalSha256
});
```

`journalSha256` identifies the whole saved envelope, not a signature. Updates
require the exact head that the caller observed; a stale head fails without data
mutation. The prior plan and every record are replayed through the unchanged
reconciler. Entry-chain hashes, final derived state and canonical file bytes must
match. An identical latest observation with the correct head returns
`duplicate:true` without replacing the file or adding a record. Older duplicates
are not a reason to ignore a stale head or conflicting revision.

Each journal has at most1024 accepted observations and2MiB of encoded bytes.
No truncation, compaction, automatic revision allocation or automatic reset is
performed. At capacity, latest duplicates remain idempotent; new records fail.
Full replay/snapshot replacement is O(history length) per operation, intentionally
bounded. No performance improvement claim is made.

## CLI

```sh
# Use an existing, private local parent. This example does not contain real orders.
mkdir -m 700 "$HOME/realdex-observations"
node node/spot-order-journal.mjs init \
  --directory "$HOME/realdex-observations/order-1" \
  --plan plan.json --observation first-observation.json

node node/spot-order-journal.mjs inspect \
  --directory "$HOME/realdex-observations/order-1"

# Replace the placeholder with the exact journalSha256 returned by inspect/init.
node node/spot-order-journal.mjs append \
  --directory "$HOME/realdex-observations/order-1" \
  --observation next-observation.json --expect-head EXPECTED_SHA256
```

Only `init` and `append` mutate data. `inspect` is read-only and may include
`--expect-head SHA256`. The original synthetic `node/spot-order.mjs` is unchanged.
No command implicitly prepares/submits an order or silently unlocks a stale lock.
Errors use nonzero exit codes and do not echo filesystem paths or input data.

## Commit and crash semantics

A cooperating writer exclusively creates `.write-lock` with O_EXCL, syncs it and
the directory, validates existing history and the expected head, and writes a
same-directory `.journal.pending` file. It fsyncs the file, renames it over
`journal.json`, and fsyncs the directory before removing the lock and returning.
Readers reject active locks and check two complete replays for a stable snapshot.
Another writer either sees the lock or subsequently rejects its stale head.

Failures during input/history validation happen before data mutation and remove
only this invocation's lock. Failures after beginning storage mutation yield
`INJ_JOURNAL_WRITE_UNCERTAIN`, retaining remaining evidence and locks. A complete
new snapshot may already be installed: NEVER assume this error means no write
occurred. A process crash before/after rename leaves old/new complete data and a
lock, not a silently accepted partial snapshot. Lock deletion itself is not
fsynced: power loss can conservatively resurrect a stale lock, not authorize an
uncertain write. This is not a measured hardware-power-cut guarantee.

There is deliberately no automatic stale-lock expiration or recovery command.
After a crash, stop all cooperating writers, preserve the entire directory, and
review the file, pending file and external expected head. A forensic COPY of the
committed journal in a new private directory can be replayed for diagnosis; this
does not authenticate freshness or authorize deleting a lock in the original.
Do not strip a lock while another process may still be operating.

## Boundaries

`historyAuthenticated`, `settlementVerified`, `signingEnabled`, `broadcastEnabled`
and `executable` remain false in every receipt. The underlying state also denies
reservation release and automatic retries. Observations and terminal status are
caller reports, not chain proofs. Hashes are unkeyed and reproducible by anyone.
A consistent whole-file rollback is detected only when the caller retains a
newer expected head outside that file. No anti-rollback hardware or remote
checkpoint is provided, and file permissions are not encryption or OS key storage.

The design follows the documented Node fs open/fsync/rename primitives. File
fsync alone does not guarantee directory-entry persistence; a separate directory
fsync is used. OS/storage behavior remains part of the trust boundary.
Primary references consulted2026-09-07:
- https://nodejs.org/docs/latest-v22.x/api/fs.html
- https://man7.org/linux/man-pages/man2/fsync.2.html
- https://man7.org/linux/man-pages/man2/rename.2.html

## Verification

```sh
node --test --test-reporter=tap node/external/test/injective-journal.test.mjs
node app/ci.mjs --suite external --jobs 1 --output /new/path/external
node app/ci.mjs --suite all --jobs 3 --output /new/path/all
```

Tests use disposable private directories, real subprocess restart/contention/
termination, injected write/fsync/rename/unlink failures, capacity boundaries,
corrupt/truncated/cross-plan input and independent Python integer/hash checks.
Simulated process termination is not a hardware power-cut test. Test counts,
exact final commit/tree and raw evidence are in the delivery report and PR.
Full release acceptance, independent review and the existing deferred runtime
prerequisites remain separate from successful development CI.
