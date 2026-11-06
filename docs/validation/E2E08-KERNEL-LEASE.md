# E2E08: same-directory kernel-lease recovery candidate

This is an additive **experimental storage candidate on E2E07's INJ12-derived reference**.
It is not a recovered INJ13 implementation, not a product successor or a deployment approval.
The default PrivateStore, WalletServer, Vault, signer, submit/reconcile and production CLI are unchanged.
No user Vault path or protected INJ13 Vault is supported. Enrollment is allowed only in a NEW empty,
owner-private `realdex-e2e08-vault-*` directory in explicit disposable-test mode.

## Mechanism

Python's standard-library fcntl.flock obtains LOCK_EX|LOCK_NB on a permanent `writer.lock` inode,
then execs the fixed Node candidate host. Its open file description is inherited across exec;
there is no surviving helper process or PID file used to infer whether a writer died. Other starts
must acquire the same kernel lock. On process death, after all copies of that open file description
close, the kernel releases the lease. The marker and inode are NOT unlinked, renamed or replaced.

The candidate store checks `/proc/self/fdinfo/FD` for this process's exclusive flock on that exact
inode before every read/write. A marker alone is insufficient; an unlocked or replaced descriptor
fails closed. File I/O is delegated to the original PrivateStore methods, including exclusive
create, encrypted-data size limits, temporary file/fsync/rename and parent directory fsync.

The persistent marker intentionally makes legacy PrivateStore fail its `wx` acquisition even when
no kernel writer is running. Do not delete this barrier to open the directory with another mode.
Existing PID-only lock files, old Vault directories, partial markers, symlink/hardlink/nonregular
locks, unsafe permissions and unsupported filesystem types are refused. No forced takeover API,
stale PID inference, timeout-based lock deletion, automatic migration or checkpoint reset exists.

Only Linux x86-64 with an allowlisted filesystem type is supported. Allowlisting a filesystem magic
is not a certificate about a real volume's full storage stack or power-loss durability. NFS/SMB and
unrecognized types are refused. Advisory locking does not protect against same-user hostile code,
privileged filesystem mutation, explicit lock release by a duplicated descriptor, or deleting both
Vault and marker. All untrusted code in the same process is outside the threat model.

## What the real-node scenario checks

Two fresh fictitious owners use the original owner API against a pinned local Injective node.
The candidate host is killed with SIGKILL (1) after persisting SUBMISSION_STARTING but before network
submission, and (2) after inclusion but before result persistence. The same directory and permanent
lock inode are re-opened by a new process. No Vault copy, lock unlink, backup import or automatic
resend occurs. The encrypted bytes must be identical immediately after unlock; journal, signed bytes
and tx hash must survive. Old token, resubmission and a new approval while unresolved are refused.
Final sequence/bank/exchange/gas deltas must match zero sends or one send respectively.

This proves only the tested candidate path with disposable local data. It does NOT validate INJ13
checkpoint integration, old-backup rollback detection, production OS key isolation, public network
transactions, a real browser or power failure. Mid-write .write-* files are never used as an implicit
backup; legacy PID-only stale locks are not repaired. The general supported-store migration remains
an integration decision after the missing INJ13 source is recovered.

## Reproduction

On Linux x86-64, provision the already pinned archive without repinning it:

```sh
python3 -I integration/injective/provision.py --archive /fixed/linux-amd64.zip --output /new/runtime
node --test --test-reporter=tap integration/owner-e2e/test/kernel-lease.test.mjs
node integration/owner-e2e/run-kernel.mjs --runtime-dir /new/runtime --output /new/evidence \
  --expect-commit FULL_COMMIT --expect-tree FULL_TREE
```

The runner accepts no existing wallet or chain URL. It checks exact Git contents and the unchanged
INJ12 reference product before executing the additive candidate. Its receipt is separate from the
old crash-copy evidence and from the six-group original owner acceptance; it does not promote those
profiles or relabel any previously blocked browser test as passed.

Primary references inspected 2026-09-08:
- https://man7.org/linux/man-pages/man2/flock.2.html
- https://man7.org/linux/man-pages/man5/proc_pid_fdinfo.5.html
- https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html
