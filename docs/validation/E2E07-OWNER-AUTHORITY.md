# E2E-07 — Owner HTTP authority boundaries (reference-only)

Parent: E2E06 `f06a61e3dc6dc34184b4afb6ea8fe65572c33eeb`, tree
`3ea43d62138f3b0ec5849215eb1b10944ad39a89`.
The product remains the protected INJ12 reference lineage, not the unavailable
INJ13 checkpoint implementation. No product wallet, signing, persistent-state,
runtime pin or release gate is modified. Do not use this reference with user
Vaults or checkpoint-protected Vaults.

## What this adds

`run-authority.mjs` starts the unmodified WalletServer in a separate child and a
hash-pinned, peerless local Injective chain. All keys and funds are disposable.
It uses real loopback HTTP, no synthetic server responses and no browser routing
interception. Host telemetry observes store writes and the existing engine's
query/send calls; it forwards each call unchanged, never retries, and does not
replace authority decisions.

The same valid deposit is carried through three stages: prepare, approve, submit.
At each stage fourteen malformed/unauthorized transport variations must be
rejected: absent/wrong owner capability, absent/foreign/allowed-dapp/null Origin,
wrong Host, absolute foreign request target, query token, cross-site Fetch
Metadata, GET, OPTIONS, form Content-Type and malformed JSON. This includes a
correct owner capability paired with a wrong Origin; each guard is exercised
independently. Absolute-form request tests connect to the loopback server only.

Six more requests target the dapp/agent surfaces without their required authority.
These tests do NOT create a valid agent or dapp capability and do not certify all
existing policies. Merely allowlisting a dapp Origin or presenting an owner token
to a different route cannot substitute for a supported operation.

All48 rejections require the exact expected status/error. A different failure is
not a pass. The encryption digest, complete record digest, pending-request digest,
Vault epoch/lock state, write count and Injective query/send counts must be
unchanged around each rejection. HTTP error responses must contain only the
expected error field and never a capability. Owner responses must not grant CORS
access. No raw response, request body, token, secret or local Vault path is saved
in these observations.

Positive controls then approve and send the original valid deposit once. Its
node inclusion, exact base/exchange balances, account sequence and one fee are
checked. The allowed operation must still work after all rejections.

The real owner rate limiter is exhausted with valid read-only status requests,
without modifying the clock/counter or handler. At most601 requests are made.
A new mutation remains429; the emergency lock still returns200. The server then
closes normally and reopens the same encrypted directory in a fresh process.
Old capability use is rejected; a repeated submission of the stored transaction
is rejected without another send. This is NOT stale-lock recovery after SIGKILL.

## One acceptance command

The existing `integration/owner-e2e/run-acceptance.mjs --profile api` now requires
an additional `authority` group, alongside all previous runtime/scenario groups.
It cannot silently skip it. The group has60 sequential assertions, including48
rejected operations. These are assertions within one actual-node scenario, not60
independent Node test cases.

```sh
node integration/owner-e2e/run-authority.mjs \
  --runtime-dir /absolute/verified-injective \
  --output /new/evidence-outside-source \
  --expect-commit FULL_COMMIT --expect-tree FULL_TREE
python3 -I integration/owner-e2e/check-authority-evidence.py \
  --directory /new/evidence-outside-source \
  --expect-commit FULL_COMMIT --expect-tree FULL_TREE
```

Use the real commit/tree returned by the reconstructed bundle; no mutable branch,
public URL, existing user directory, case filter or skip flag is accepted.
The runner validates all source blobs/modes and the pinned runtime before/after.
The independent Python checker verifies the exact rejection matrix, unchanged
snapshots, integers, inclusion and balance arithmetic, HTTP hardening headers,
file manifest and chronological steps. It never executes imported JS or queries
an RPC. Self-hashed evidence is not a signature or independent observation.

## Scope limits

Real HTTP requests with hand-written Origin/Fetch headers are NOT actual browser
CORS, DOM, navigation, DNS-rebinding, network MITM, external penetration tests or
an independent security audit. A malicious same-OS program with the owner token
can spoof HTTP headers. These tests do not claim protection from that capability
compromise, root user, OS malware, arbitrary proxy behavior or browser policy.
No attempt is made to change or bypass managed browser policies.

INJ13/checkpoint integration, same-directory crash recovery, root build, all other
chain runtimes, public testnet and release approval remain separate tasks.
`browserEndToEndPassed`, `productionReady`, `wholeProductAcceptance`,
`checkpointCompatibilityVerified`, `independentAudit` and `productSuccessor`
remain false. GitHub is not used by this local validation workflow.

Primary protocol references (not certification of this product):
- https://nodejs.org/download/release/v22.16.0/docs/api/http.html
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Origin
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Sec-Fetch-Site
