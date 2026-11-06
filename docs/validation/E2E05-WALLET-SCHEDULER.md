# E2E-05: bounded wallet-suite file scheduling

## Reference, scope and integration boundary

Base: E2E-04 reference commit `3087f0346d9e842d4a3a3f106fdd5218b61bbe19`,
tree `413653f5bbaef872f721c9569786d3286ce3e171`.
This is an INJ-12-derived verification branch, NOT the unavailable INJ-13
checkpoint product. Do not use this reference checkout to open user Vaults or
checkpoint-protected Vaults. No production wallet, signer, storage, checkpoint,
transaction, UI, dependency or acceptance gate is changed by this patch.

E2E-04 evidence contains two 600-second wallet-suite timeouts. Their logs record
hundreds of completed passing tests, not proof that every test completed. The
old runner schedules every file serially. The new runner schedules at most two
files concurrently, each in its own Node process, while preserving test order
and fixtures within each file. This changes scheduling, NOT the KDF, assertions,
test inventory, user permissions or financial execution. Historical timeouts
remain failures. A successful new run does not retroactively pass them.

## Commands and resource ceiling

```sh
node wallet/test/run.mjs                 # default: min(2, available CPUs, files)
node wallet/test/run.mjs --jobs 1        # serial control, same complete inventory
node wallet/test/run.mjs --jobs 2        # still capped by available CPUs/files
node --test --test-reporter=tap app/test/wallet-runner.test.mjs
node app/ci.mjs --suite all --jobs 3 --output /new/absolute/evidence-directory
```

No test filtering, shards, force-exit, retries or configurable time extension are
accepted. Invalid options, empty/oversized discovery and nonregular matching
entries fail before spawning tests. Node produces one native TAP stream; the
wrapper adds only a descriptive TAP comment and preserves abnormal/nonzero exits.
The existing `processEvidence()` still rejects missing/duplicate counters, skips,
todos, cancellations and failures. The full-suite supervisor retains its exact
600000ms per-suite timeout and process-group termination behavior.

Concurrency applies to FILE processes, not concurrent test cases within a file.
The outer `--jobs 3` remains three suite processes, but wallet may now have two
active file workers: up to four active file workers across three source suites,
excluding helper processes already started by tests. This can use more RAM/CPU
at once and is not a guarantee for a low-memory, single-core or oversubscribed
host. No scrypt settings, encryption, fsync, state teardown or test vectors were
modified. `--jobs 1` is retained for diagnosis, not an automatic retry or a way
to turn an initial failed run into a pass.

Tests use new private temporary directories and ephemeral loopback ports; Node
process isolation keeps per-file globals/prototype mocks separate. The direct
wallet runner now uses the same allowlisted child environment as source CI so
ambient NODE_OPTIONS, proxies, runtime paths or wallet credentials cannot alter
selection/scheduling or turn it into an external network test. A developer who
adds a shared external resource to a future test must declare and isolate it;
this patch is not a universal proof that arbitrary new tests are race-free.

## Reproducible verification

New tests cover selection/resource bounds, unknown flags, missing inventory,
symlinks, exact exit behavior, environment filtering, serial/parallel name/count
agreement, real simultaneous workers, maximum active workers, per-file process
isolation, serial ordering inside files, non-fail-fast behavior, skipped tests,
real child signals and the existing supervisor's timeout.

The delivery records complete-source hashes, exact tested Git commit/tree,
raw TAP and process receipts. For timing comparisons, run baseline and final
sequentially on the same machine; never infer a speedup from unrelated hosts or
truncate missing tests to zero. Compare the full ordered test-name inventory
and all six TAP counters, plus unchanged wallet test/fixture and product bytes.
Final numbers belong in delivery evidence, not in mutable in-source assertions.

Primary Node 22.16.0 scheduling reference:
https://nodejs.org/download/release/v22.16.0/docs/api/cli.html#--test-concurrency
https://nodejs.org/download/release/v22.16.0/docs/api/cli.html#--experimental-test-isolationmode

No GitHub publication or production approval is implied. Missing INJ-13 source,
root build, whole-chain acceptance, browser policy, OS key/checkpoint integration,
public testnet and independent review remain distinct completion requirements.
