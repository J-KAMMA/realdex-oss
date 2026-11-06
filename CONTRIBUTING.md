# Contributing

RealDEX is licensed AGPL-3.0-only (see `LICENSE` and `docs/LICENSING.md`).
Contributions are accepted under the same licence.

## Workflow

- One task per branch. Open a pull request against the default branch.
- Do not replace reviewed source with an older archive merely because its files
  are available; inspect the relevant pull request before selecting work.
- No credentials, wallet stores, generated private logs or release archives belong
  in Git. `node dev/source-hygiene.mjs <ref>` scans selected patterns throughout
  reachable history, including deleted files; it is not a complete secret detector.
  Do not bypass a finding just to publish.

## Verification

```sh
pnpm test
node app/ci.mjs --suite all --jobs 3 --output ci-output
node app/verify.mjs --full --output acceptance-full
```

Some suites contain checks that need the maintainers' internal planning files or
git history; they skip themselves with an explicit reason when those files are
absent. A self-review is not an independent security review.
