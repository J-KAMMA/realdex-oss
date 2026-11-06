# E2E06: repaired reference entry points and one owner-runtime acceptance command

## Exact scope

Parent: E2E05 a6c63b0d14193486472de9b2dda90c35119d7579,
tree e6032d1b787c4f071cb581fe324443c9d908a4f6.
This remains an INJ12-based validation reference, NOT an INJ13 successor.
Actual INJ13/checkpoint source is unavailable. Do not open user Vaults or
INJ13-protected Vaults with this reference tree. This task changes no product
wallet, signer, asset permissions, ciphertext persistence, existing scenario
checks or original full-acceptance rules.

## Reproduced defects

On the clean unmodified E2E05 source, run-crash.mjs, run-failure.mjs and
run-concurrency.mjs all exit1 with E2E_CRASH_REFERENCE_CHANGED, before creating
outputs or starting a node. The old reference allowlist rejects the legitimate
E2E05 test-scheduler changes. Running a scenario function in isolation does not
exercise this CLI guard; earlier scenario passes do not establish CLI usability.

The old sourceIdentity checks git status, then hashes current files, without
comparing those bytes to the Git blob object at HEAD. An actual disposable Git
repository with assume-unchanged or skip-worktree demonstrates that changed bytes
can be accepted while status is clean. core.fileMode=false can similarly conceal
executable-mode changes. This is an evidence-binding defect, not a wallet exploit.

## Fixes, not a disabled guard

All four scenario entry points now share a fixed INJ12 product-identity guard.
Every INJ12 baseline file must remain byte/mode-identical, except wallet/test/run.mjs
which may use its original value or the exact E2E05 scheduler blob. Its paired
implementation and test file must also match pinned E2E05 blobs. New paths are
limited to owner-e2e validation, explicitly named app registrations, and E2E
validation documentation. New product paths/checkpoint implementations,
changed existing product files, unknown schedulers, symlinks or submodules fail.
The base commit/tree and ancestry are fixed; they cannot be selected by a CLI flag.
Callers must separately pin the COMPLETE current commit/tree and have a clean tree.
sourceIdentity now also computes every working file's Git blob identity and
checks executable mode, independent of status and its optional shortcuts.
This is not a sandbox against privileged concurrent writers, hostile Git,
self-rehashing replacement source, or transient edits restored before checks.

## Unified execution

On Linux x86-64 with the existing verified Injective runtime:

```sh
node integration/owner-e2e/run-acceptance.mjs \
  --profile api --runtime-dir /absolute/verified/runtime \
  --output /new/output/outside/source \
  --expect-commit FULL_REVIEWED_COMMIT --expect-tree MATCHING_TREE
```

The command sequentially executes once: all seven existing Injective runtime test
files, the actual owner-API roundtrip, the two crash boundaries, included-failure
recovery, and concurrent owner/lock/disconnection cases. There are no per-case
filters, retries, silent time extensions, fixture-only replacements or remote
orders. The runtime group has a 600-second bound; each scenario 360 seconds;
independent checkers 30 seconds. Existing runProcess owns/terminates its Unix
process group and bounds logs. Disposable local genesis actors only. Some
scenario child hosts create their own groups and also have existing cleanup;
this wrapper does not claim cgroup/whole-machine isolation or power-loss cleanup.

Per-scenario success requires successful child completion, exact output filenames
and hashes, current full commit/tree/source bytes, before/after equality, a fresh
report timestamp, the existing detailed JavaScript verifier, and the existing
independent Python checker. Any failure is recorded and does not stop execution
of the other independent groups. Changed source rejects subsequent executions.
The pinned runtime files are hashed before and after; unexpected test inventory
changes are rejected for review rather than silently omitting or adding scope.
All reports and logs are retained separately; named Node tests and scenario
checkpoints are not summed into one misleading test count.

`--profile api` leaves browser explicitly not-run. `--profile browser` additionally
requires the ORIGINAL managed-Chromium DOM driver and real server/node roundtrip;
API success, mocks and policy failure cannot satisfy it. It does not select an
alternate browser, alter management policies/CSP, or bypass network restrictions.
Existing browser-policy blocks are unresolved; this task does not re-execute or
work around the blocked browser path. Both profiles always keep production,
public-network, whole-product and INJ13/checkpoint approval false.

## Tests and remaining work

```sh
node --test --test-reporter=tap app/test/owner-acceptance-addon.test.mjs
node app/ci.mjs --suite all --jobs 3 --output /new/source-regression
```

New tests use disposable Git repositories and explicitly synthetic evidence for
negative validator testing. Actual complete CLI/runtime execution is separate,
recorded by the distribution report on its exact final commit. Original scenario
modules/checkers and product bytes are retained. Future INJ13 integration must
review this guard and perform a new explicitly identified protected-source
acceptance, not relax its present identity constraints or reuse old receipts.

Node22.16.0 child process reference:
https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html
Git index options reference:
https://git-scm.com/docs/git-update-index
