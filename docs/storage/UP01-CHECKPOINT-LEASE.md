# UP01 — integrated protected owner storage (2026-09-08)

## Identity and scope

This is a new integrated implementation based on E2E08 commit
`5e185fbf6fd28569e7b4e68c04d6deb19d9515a3`, not recovered INJ13 code.
Its protection format is `realdex.vault-checkpoint-lease.v1`.
INJ13 source/format compatibility is NOT established. Do not open user or INJ13 Vaults.
Only explicitly enrolled, new, empty Linux x86-64 owner-only directory pairs are allowed.

UP01 changes Vault's storage binding/session checks and backup/restore behavior only
when this new store is selected, and adds the explicit launcher/owner entry and UI notice.
Signature algorithms, transactions, owner confirmation, no-resend and network restrictions
remain in the existing product code. Default `wallet/cli.mjs` storage is unchanged.
The new `wallet/protected/owner.mjs` runs the real WalletServer and real owner UI;
it has no fixture keys, fault controls, kill endpoints or public-network opt-ins.
Integration test hosts with those controls live under `integration/protected/` only.

## Two locks, one encrypted state

`launch.py` obtains nonblocking exclusive flock leases on permanent `writer.lock`
files in BOTH the Vault and checkpoint directories and execs the owner process
with those descriptors. There is no lease-holding supervisor, PID timeout guess,
stale-lock deletion or alias directory. Marker identities bind the pair and its
physical directory identities. Each store access checks owner/mode/link/inode,
marker pairing, and the actual locks in `/proc/self/fdinfo`.

The encrypted Vault payload additionally contains the scheme and random pair ID.
It cannot be unlocked or restored with a normal store: current code rejects a
missing binding, and older code rejects the unknown authenticated payload field.
Copying the ciphertext away from its lock files does not remove that restriction.
This is not a sandbox against trusted-process changes or a compromised OS user.

## A write and interruption semantics

The checkpoint is small metadata (generation, current ciphertext hash and size).
It is NOT a ciphertext backup. Each write, under both leases:

1. Writes the next ciphertext as a staging file; fsyncs that file and its directory.
2. Atomically replaces and fsyncs the checkpoint with an intent binding old and next
   exact generation/hash/size. No transaction send has been authorized by this step.
3. Renames that exact stage over the Vault and fsyncs the Vault directory.
4. Atomically replaces/fsyncs the checkpoint with the committed next generation.
5. Only then returns success to the existing Vault/owner flow.

An exception poisons the store for the rest of that process and the Vault locks.
A new explicit process start can recover a durable intent ONLY when the current
body is the recorded old or new version and the required stage is exactly the
recorded new version. It never regenerates keys, signatures, requests or sends.
The recovery completes storage of the recorded bytes, not execution of a transaction.

If there is no intent, an uncommitted stage is discarded after the committed body
is verified. Atomic temp files are never adopted as backups/checkpoints. Corrupt,
missing or conflicting intent/stage/checkpoint contents fail closed. A missing
checkpoint never causes an existing pair to be re-enrolled. Enrollment interrupted
before valid markers+initial checkpoint is a failure, not automatic repair.

After signed/sending state is durable, restoring that state does not grant retry.
`broadcast-unknown` remains unknown until the existing chain reconciliation applies.
A failed save after intent may later recover a state whose API response was an error;
callers must inspect current history, not repeat the operation automatically.

## Session, backup and restore

Each unlocked Vault holds a token for the exact committed generation/ciphertext.
All normal checks verify that token and the disk/witness contents. Another session
cannot update the store and leave an older session authorized to sign or overwrite.

Protected backup verification requires the EXACT current ciphertext and entire
decrypted state, not only matching accounts. When account backup confirmation
changes the encrypted state, the response includes the newly current ciphertext;
the UI downloads it. Re-verifying an already verified current backup does not save
another generation. Later transaction/history/password saves make prior backups old.
Keep the latest backup after state changes; this design does not magically update
external copies.

With a valid latest checkpoint but a missing Vault body, the owner server starts
locked. `/api/restore` authenticates the supplied password/binding and restores ONLY
the exact current ciphertext. It does not reset the generation, re-encrypt a stale
backup, clear journal entries, revoke/recreate requests, unlock automatically or send.
When a nonmatching body exists, startup fails; UP01 has no "force restore" or automatic
quarantine. Fault tests delete only deliberately damaged fixture body files to
exercise the separately defined missing-body recovery, never lock files.

## What it does NOT guarantee

Unilateral Vault or checkpoint rollback, mismatch, missing latest data, stale
session and conflicting writers are detected. If BOTH the Vault and its checkpoint
are coherently rolled back, local hashes cannot detect it. Tests explicitly show
this limit. The witness is a separately maintained local record, not independent
consensus, secure hardware, remote attestation or authenticated chain state.
Pair relocation/loss, INJ13 migration, Windows, NFS/SMB, real power failure, hostile
same-user/admin processes, replicated backups and third-party audit remain open.

flock is advisory and tied to an open file description; duplicated descriptors can
keep the lease alive or release it. Filesystem allowlisting is not a hardware
durability certificate. Synchronous I/O and fsync are not proof against all power,
firmware, storage-controller, kernel or compromised-process failures.

## Commands (new disposable directories only)

```
mkdir -m 700 /new/up01-vault /new/up01-checkpoint
python3 -I -S wallet/protected/launch.py \
  --directory /new/up01-vault --checkpoint /new/up01-checkpoint \
  --enroll --acknowledge-experimental --port 8790
```

On subsequent explicit starts use the SAME two directories and omit `--enroll`.
The resulting capability URL is secret: do not put it, passwords, ciphertext,
keys, chain homes or test fault fixtures in issue logs or public artifacts.
The launcher's standard-library-only `-S` invocation avoids unrelated Python site
initialization; it does not change browser policies or permissions.
Mutable network settings in this candidate entry are not persisted: settings
changes are rejected rather than acknowledged as durable.

## Validation and primary semantics

Focused tests run with `node --test --test-reporter=tap integration/protected/store.test.mjs`.
The exact-commit integration runner is `integration/protected/run.mjs`.
Legacy E2E reference-only runners intentionally reject the changed product tree;
their old INJ12 success is not re-labeled as a UP01 acceptance result.

- https://man7.org/linux/man-pages/man2/flock.2.html
- https://man7.org/linux/man-pages/man2/fsync.2.html
- https://man7.org/linux/man-pages/man2/rename.2.html
- https://man7.org/linux/man-pages/man5/proc_pid_fdinfo.5.html
- https://nodejs.org/download/release/v22.16.0/docs/api/fs.html

Final measured scope, failures and identities belong to the delivery report and
raw logs, not to this design document. No production or release gate is promoted.
