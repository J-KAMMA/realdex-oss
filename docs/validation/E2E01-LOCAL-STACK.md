# E2E-01: real owner stack acceptance harness (add-only, not a product release)

## Source boundary

This task could obtain and independently rehash INJ-12 distribution
`RealDEX-INJ12-IBC-Simulation-2026-09-07.zip`, SHA-256
`9492829b934c8ae0ed88bab6d10b8b80fcf15de4b736608c55db47f771f92855`.
Its commit is `a0bb48445bc4d626806697475fc7965485b1a9ac`, tree
`dcaf00429368fcbe83bb62b5b98bd1ddef627135`. All 1,220 original manifest entries
were verified before creating an isolated reference worktree.

The previous conversation reports INJ-13 Vault-Checkpoint, but its source,
commit/tree pins and distribution ZIP were not available in this task's runtime
or targeted file-library searches. It is NOT replaced/reconstructed here.
This task only adds integration tests/runner files and this document. It does not
edit any old source, Vault, checkpoint, signing/receipt code, root dependencies,
CI or acceptance flags. The INJ-12-plus-addon bundle is a REFERENCE ONLY, not a
successor to INJ-13 and MUST NOT be used to open an INJ-13 protected/user Vault.
Integration and compatibility testing on the actual INJ-13 remain pending.

## Scope and local task

Task `E2E-01` follows roadmap `INJ-END-TO-END`, with separate API control evidence.
Allowed additions: `integration/owner-e2e/**`, `app/test/owner-stack-addon.test.mjs`,
`docs/validation/E2E01-LOCAL-STACK.md`. This is an explicit test-only scope addition.
No GitHub publication, overwrite of another worktree, merge or production approval.

## Two deliberately distinct modes

`api` drives actual HTTP calls against an unmodified WalletServer in a separate
Node process and an actual pinned local Injective node. `browser` drives the same
sequence using DOM forms/buttons in the normal system Chromium through Playwright
1.57.0. API success is never browser success; there is no fallback mode and no
mock `route.fulfill`, injected fetch replacement or synthetic REST response.

Normal browser enterprise/admin policy is respected. No different browser,
proxy, CSP bypass, web-security switch or policy file modification is provided.
If navigation is blocked by policy, browser mode records BLOCKED and exits 2.
A genuine test failure exits 1. A completed, checked mode exits 0. An API exit 0
still retains `browserEndToEndPassed:false` and `productionReady:false`.

## Fixed lifecycle and accounting

A disposable owner and counterparty receive fictitious genesis assets. The
existing local fixture's genesis admin launches the market and clears startup
post-only mode; these actions are not product permissions or public operations.
The owner uses its existing approval/storage/first-submit APIs for:

1. Deposit 2 BASE into its own nondefault subaccount.
2. Place a 2-BASE sell at 11 QUOTE/BASE.
3. After the independent counterparty buys 0.5 BASE, cancel the 1.5 remainder.
4. Withdraw the 1.5 remaining BASE.
5. Withdraw all available sale proceeds in QUOTE.

The driver must separately confirm review SHA and stored transaction hash. A
wrong hash cannot send. The test intentionally consumes one actual submission
response AFTER the node has replied, leaving the final withdrawal unknown. It
normally closes the server, starts a NEW Node process, rejects the old UI token,
and reconciles the stored hash without any send by the restarted process.
It never introduces an unrestricted signing HTTP fixture endpoint.

Exactly five owner sends, one counterparty send, five owner sequence increments,
five owner fees, unique owner hashes and zero remaining exchange balances are
required. Maker fees/rebates and fee-recipient bank credits are accounted for
separately from the proceeds available in the exchange account. Python Decimal
recomputes the net quote effect from the FIXED quantity/price plus the actual
market's maker rate; it does not use the JavaScript result as its expectation.
The scenario requires integral atomic fees and rejects unsupported dust rather
than silently rounding. The node's included gas cap is compared with the signed
cap. No comparison of current gas-used estimates is weakened.

## Run on an isolated permitted machine

Use the existing, unchanged `integration/injective/provision.py` with the exact
archive named in `integration/injective/pin.json`. No third-party binary is
redistributed by this addon. The provisioner verifies the binary before running.
The runner verifies ALL tracked source files and requires a clean Git checkout
and explicit full commit/tree pins. Outputs must be outside that checkout and in
a NEW directory. No wallet path, public endpoint or imported-user-key CLI option
exists. Only fresh disposable directories and keys are used.

```sh
node --test --test-reporter=tap app/test/owner-stack-addon.test.mjs
node integration/owner-e2e/run.mjs --mode api \
  --runtime-dir /verified/injective-tools --output /new/api-evidence \
  --expect-commit FULL_TESTED_COMMIT --expect-tree FULL_TESTED_TREE
python3 -I integration/owner-e2e/check-evidence.py /new/api-evidence/result.json
# This is separate. Do not call API mode a fallback/passing substitute.
node integration/owner-e2e/run.mjs --mode browser \
  --runtime-dir /verified/injective-tools --output /new/browser-evidence \
  --expect-commit FULL_TESTED_COMMIT --expect-tree FULL_TESTED_TREE
```

The runner's `result.json` is source-bound and includes all completed check IDs,
public transaction hashes and numerical balances, not keys, capability tokens,
unsigned review JSON or raw server errors. `source-before/after.json` covers ALL
tracked source (including documents/images), rather than only the original
acceptance snapshot subset. `FILES.json` checks the evidence files. These hashes
are local integrity data, not authenticated node/state proofs or signatures.

## Process/error tests and limits

Unit/fault tests use real subprocesses for nonzero exit, missing result, duplicate
IDs/JSON keys, oversize output, ignored deadlines, signals, malformed frames and
simulated policy-block ERROR classification. A simulated policy error test is not
a real browser run. Source identity tests reject dirty/untracked trees, short or
wrong pins, reused output and symlink paths. All cleanup operations run and retain
the primary failure together with cleanup failures instead of masking it.

The hardcoded trusted fixture/runner is not a sandbox for malicious source,
privileged local attackers or hostile filesystem replacement. Ordinary process
shutdown is not an actual power failure. Processes and temporary keys are
cleaned up; JavaScript strings are not guaranteed zeroized. Testing is Linux only.
Public networks, production assets, independent audit, OS key isolation, INJ-13
checkpoint behavior and strict all-chain acceptance are not certified here.

Primary API documentation checked during implementation:
- https://playwright.dev/python/docs/api/class-browsercontext (route, service workers)
- https://playwright.dev/python/docs/api/class-browser (context and browser options)
- https://nodejs.org/api/child_process.html (process exit, signals and limits)
