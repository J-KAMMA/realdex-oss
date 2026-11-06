# Bitcoin Core regtest integration (v0.15)

The suite starts one disposable, hash-pinned Bitcoin Core CI development build with P2P disabled. Owner requests go through the real WalletServer over HTTP; signing and durable state are production modules. The two authenticated HTTP forwarding endpoints both reach the **same node**, not independent consensus witnesses. Fault hooks only simulate transport loss or malicious RPC responses for negative cases.

No existing user vault, chain data, production key, public RPC, or mainnet is opened. Core's wallet is disabled. Tests mine valueless outputs directly to independently generated RealDEX addresses and submit RealDEX-signed transactions. Block invalidation uses the real regtest chain; it is not a distributed-network reorganization test.

Set `REALDEX_BITCOIND_BINARY` to the pinned executable described in `pin.json`. Tool absence is an error or blocked gate, not a skipped passing test. No automatic binary download or unpinned fallback.

```sh
node integration/bitcoin/demo.mjs
node --test --test-concurrency=1 --test-reporter=tap integration/bitcoin/Payments.test.mjs
node app/verify.mjs --bitcoin --output acceptance-bitcoin-new
```

The toolchain archive is a separate optional test dependency. See `wallet/docs/v015/QUICKSTART-JA.md` for its hash, source, extraction path and limitations. Normal wallet startup does not require this binary.
