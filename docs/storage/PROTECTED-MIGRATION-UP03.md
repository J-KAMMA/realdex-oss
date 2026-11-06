# UP03 protected-pair migration

UP03 adds an explicit migration path for the protected Vault/checkpoint pair. It is not a backup rollback tool and it does not migrate the unavailable historical INJ13 format.

## Threat and operating model

The protected store binds ciphertext to a pair identifier and to two owner-only directories. Copying only `vault.json` to another pair is deliberately rejected. UP03 therefore re-encrypts an unlocked, quiescent Vault for one already-enrolled destination pair and freezes the source before the package can be used.

Migration has four explicit commands:

1. `target`: enroll a new empty destination pair and create a one-time target descriptor plus an Ed25519 receipt key inside the destination checkpoint directory.
2. `export`: verify the source has a current verified backup and no unresolved EVM/non-EVM/Injective operations, rebind a copy to the target pair, revoke persistent agent activation, write the encrypted migration package, and freeze the source.
3. `import`: require the exact target descriptor, decrypt/authenticate with the owner password, write generation 1 only into the empty destination, and produce a signed receipt. Re-running the exact import is idempotent.
4. `finalize`: verify the destination receipt against the target descriptor and exact package, then mark the source as migrated out. Normal source startup remains refused.

There is intentionally no product `abort` after export. Once the source is frozen, finish the same migration. This prevents an imported destination and a resumed source from becoming two writable histories.

## Example

Create two empty owner-only directories on the destination host/filesystem, then:

```sh
python3 -I -S wallet/protected/migrate.py target \
  --directory /secure/new-vault \
  --checkpoint /separate/new-checkpoint \
  --descriptor /secure-transfer/target.json \
  --enroll --acknowledge-experimental
```

Carry `target.json` to the source and, with the normal protected owner stopped:

```sh
python3 -I -S wallet/protected/migrate.py export \
  --directory /secure/old-vault \
  --checkpoint /separate/old-checkpoint \
  --descriptor /secure-transfer/target.json \
  --package /secure-transfer/migration.json \
  --acknowledge-experimental
```

The password is read through a terminal prompt and is not placed in argv or the environment. The source is now frozen. Transfer `migration.json` to the destination and import it:

```sh
python3 -I -S wallet/protected/migrate.py import \
  --directory /secure/new-vault \
  --checkpoint /separate/new-checkpoint \
  --package /secure-transfer/migration.json \
  --receipt /secure-transfer/receipt.json \
  --acknowledge-experimental
```

After unlocking and checking the destination, carry `receipt.json` back to the source and finalize:

```sh
python3 -I -S wallet/protected/migrate.py finalize \
  --directory /secure/old-vault \
  --checkpoint /separate/old-checkpoint \
  --receipt /secure-transfer/receipt.json \
  --acknowledge-experimental
```

## Safety properties and limits

- The package contains encrypted Vault ciphertext, not plaintext keys. Treat it as sensitive backup material anyway.
- The migration package is cryptographically bound inside the encrypted payload to source pair/generation/ciphertext and one target descriptor.
- The target receipt is signed by the Ed25519 key created with the target pair. This binds the operational handoff; it is not an independent third-party authority or hardware attestation.
- The source ciphertext itself is never rewritten during migration. Pending and retired source pairs are refused by ordinary protected startup.
- A destination that already contains another Vault is never overwritten.
- Wrong password, target substitution, package changes, receipt changes, unresolved transactions, stale/unverified backup, interrupted export and interrupted import fail closed.
- Import revokes persistent agent policy activation/token hashes. Owner/UI session tokens are process-local and are not migrated.
- The destination begins at checkpoint generation 1. The source generation is retained as encrypted migration provenance, not reused as destination generation.
- Joint rollback of all owner-controlled records remains outside this protection model. UP03 does not create an independent monotonic authority.
- Source and destination should not be used concurrently. Migration does not prove a remote host is uncompromised, does not securely erase old media, and is not a public-network transaction.
- Linux x86-64, supported local filesystems and owner-only directories remain the current protected-store scope. Windows/NFS migration is not certified.

## Required source checks

Use the pinned Node 24.14.0. The official migration runner creates a fresh child
for each of the 21 scenarios, in registry order. Each child has a fixed 30-second
limit and must report exactly its requested test, with no failure, cancellation,
skip or todo. All scenarios remain mandatory. An interruption stops new children
and leaves non-passing receipts. No KDF parameter is reduced.

```sh
node integration/protected/migration-run.mjs --output /ABSOLUTE/NEW-MIGRATION-EVIDENCE
python3 -I -S integration/protected/migration-cli-check.py
node app/ci.mjs --suite all --jobs 1 --output /ABSOLUTE/NEW-SOURCE-EVIDENCE
```

The migration output must be a nonexistent directory outside the source tree,
with an existing parent. It contains one raw TAP and receipt per scenario,
before/after source identities, and a summary. The app suite invokes this same
runner and verifies all results. Its parent test and per-scenario subtests are
counted by Node; use the actual CI totals, not an inferred increase of 21.

The CLI checker uses Python's standard library and fresh watch-only fixtures.
It exercises the production `migrate.py` commands, including real PTYs with echo
disabled for export/import, checks generation 1 and signed-receipt handoff, and
cleans up its exact temporary directories. It does not require `pexpect` or
remove `-I -S` from the production launcher.

The package's Vault identifier, account-set version and revision are checked
against the authenticated payload before a destination write. Scenario checks
also require a real nonempty active agent policy to become revoked, exercise
valid descriptor/receipt parsing before rejection checks, and use a valid
same-pair descriptor when checking distinct-pair enforcement.

Passing these checks is source-level development evidence. The pinned root
build, managed real-browser check, chain/runtime gates, public testnets and
independent review remain separate evidence categories. Preserve the original
UP02 archive and UP03 handoff failure logs alongside new results.
