# Aptos local validator integration (v0.18)

This is a test-only, single-validator Aptos VM fixture with two forwarding HTTP endpoints. It is not a public network, not two independent validators, not an independent LedgerInfo/state proof verifier, and not production approval. Tests generate disposable keys and use only local faucet balances. The forwarding layer deliberately injects failures; normal simulation, signature execution, transaction results and historical balance reads come from the real local node.

The source baseline is RealDEX v0.17 Cosmos Settlement (2026-09-06). The older v0.16 Aptos integration used a different account API; this adapter targets the current `account-online` owner API. It does not replace the latest Cosmos implementation.

## Provision without network access

Python extracts only the hash-pinned executable from the already downloaded GitHub Actions ZIP. It does not execute the file, follow archive paths, or overwrite an existing directory.

```sh
python3 integration/aptos/provision.py --archive /path/RealDEX-Aptos-Test-Toolchain-2026-09-06.zip --output /path/NEW-aptos-tools
export REALDEX_APTOS_BINARY=/path/NEW-aptos-tools/aptos
node --test --test-concurrency=1 --test-reporter=tap integration/aptos/Payments.test.mjs
node integration/aptos/demo.mjs
```

`pin.json` fixes the binary bytes/SHA-256, CLI version, core Git hash, platform and downloaded archive hash. CLI 9.5.1 / Linux x86-64 was used. This pin is a reproducibility identity, not a statement that the host or binary has been independently audited. Same-user malicious replacement races and whole-host compromise remain outside this test loader's security boundary.

The demo creates temporary chain/vault directories and removes them on normal termination. Forced termination can leave disposable test directories. Never point this fixture at an existing chain data directory or a real wallet. No backup or secret from the user is accepted.

## Acceptance integration

```sh
node app/verify.mjs --aptos --output NEW-aptos-acceptance
node app/verify.mjs --full --output NEW-full-acceptance
```

Missing/mismatched executables block the requested gate; there is no synthetic fallback. Full acceptance also requires the still-unimplemented real Stellar Core gate and the other project gates. A successful Aptos gate does not approve those gates or mainnet.
