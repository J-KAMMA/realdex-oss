# Pinned Cosmos SDK simd acceptance

`REALDEX_SIMD_BINARY` points to the executable described in `pin.json`. Verify the archive independently before extracting it. The harness refuses changed bytes, unsafe mode, symlinks, wrong platform, or absent tools before execution. This is a **development build**, not a production upgrade recommendation.

```sh
node integration/cosmos/demo.mjs
node --test --test-concurrency=1 --test-reporter=tap integration/cosmos/Payments.test.mjs
node app/verify.mjs --cosmos --output acceptance-cosmos-new
```

The fixture creates a temporary home, test validator and public disposable accounts. Genesis receives valueless test balances. It disables peer exchange and pprof, configures only loopback listening addresses, starts a single-validator chain and cleans up afterward. Wallet keys are not imported into simd. Its validator key is unrelated to the payment keys.

Two RPC/REST endpoint pairs forward to the same process. Signature and bank execution, gas, balances, sequence and block transaction proofs are real. Dropped HTTP replies and hostile result modifications are transport fault injection. This is not a multi-validator consensus, Cosmos Hub, state-proof or public-testnet test.

Absence of simd is blocked/failure, not a skipped pass. Passing this development runtime gate does not enable mainnet, AI authority, bridge settlement, or productionReady.
