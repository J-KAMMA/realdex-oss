# Stellar Core runtime gate

This directory is the real-runtime acceptance boundary for the Stellar account path.
It does **not** make the existing synthetic Horizon tests count as Stellar Core execution.

Current source state intentionally blocks the gate because `pin.json` does not yet contain
a full immutable per-platform Quickstart image digest. A mutable tag, a truncated digest,
or a public-network configuration cannot satisfy the preflight.

When an independently verified digest is added in a reviewed commit, the execution plan is:

- the exact `stellar/quickstart:<build-tag>@sha256:<64-hex>` image only;
- `--local`, protocol 28, `core,horizon` only;
- Horizon exposed on `127.0.0.1` only;
- ephemeral container; no volume and no public network;
- no automatic pull or tag substitution;
- Core and Horizon version checks before wallet evidence is accepted.

`runtime-plan.mjs` is pure and performs no process or network action. `toolchain.mjs`
performs preflight only and cannot report a runtime pass. Real runtime execution remains a
separate unfinished gate.
