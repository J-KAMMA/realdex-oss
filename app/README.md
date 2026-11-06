# Current v0.16\n\nSee [v0.16 local account-chain instructions](../wallet/docs/v016/QUICKSTART-JA.md). Real Stellar/Aptos runtime gates are explicitly blocked; synthetic HTTP success does not satisfy them.\n\n---\n\n# Local application supervisor — current v0.14

See [v0.14 Japanese instructions](../wallet/docs/v014/QUICKSTART-JA.md). `--solana` now requires both native and classic SPL LiteSVM suites. Neither is a public-validator test.

# Local application supervisor — v0.9

Run `node app/cli.mjs start` from the repository root. No external runtime dependencies are needed for these two local Node services. This is not a native installer, production sandbox, public gateway, or a substitute for the original React app build.

The supervisor starts discovery and the wallet in separate child processes and separate directories under `~/.realdex-app`. It does not migrate the old `~/.realdex-wallet` folder or copy private keys. It prints a PRIVATE wallet capability URL for the owner only. It never inserts that capability into discovery configuration or settings.

`node app/cli.mjs doctor` reads dependency manifests, not secrets or network state.

`node app/verify.mjs --full --output NEW_DIRECTORY` runs selected tests and distinguishes missing-runtime/dependency gates from successful root builds and actual EVM tests. In the packaging environment, the selected scope passes but the full command exits 2. `productionReady` is always false: external reviews and actual deployment acceptance remain separate gates.

Japanese instructions: ../wallet/docs/v09/QUICKSTART-JA.md.
