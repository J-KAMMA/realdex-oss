# E2E-02: owner-process crash boundaries (reference-only addon)

## Source and scope

This is the next **validation addon**, not an INJ-13 successor. The INJ-13 Vault
Checkpoint archive/commit/source remains unavailable. No checkpoint, product
wallet, signer, server, existing runner, dependency, or test deadline is changed.
The tested base is E2E01 reference commit
`c828e16ed6814c98ef6e1cdf2fa8f73c1468e4c1` (tree
`9df1c7e73b4397a90bcf37f37124c11a0132b322`), which adds tests only to INJ12
`a0bb48445bc4d626806697475fc7965485b1a9ac`.

The new runner refuses a reference tree with any modified/deleted original INJ12
path. It must not be pointed at user Vaults, a checkpoint-enabled Vault, or an
unreviewed newer product and treated as its integration test. Real INJ13
integration requires its real source and a checkpoint-aware fixture first.

## Two exact fault windows

The API driver uses the real WalletServer in a separate Node process and the
existing hash-pinned local Injective binary. Each case creates a fresh test actor,
password and private fixture directories. Only fictitious genesis coins are used.
The fault hook is private to `crash-host.mjs`, not installed in WalletServer/UI.

* **before-request**: the original engine has saved `broadcast-unknown` with
  `SUBMISSION_STARTING`, then the diagnostic fetch hook is reached. Before calling
  the real transport, the hook records a bounded marker and kills **itself** with
  SIGKILL. The send count is zero. Merely losing HTTP is insufficient evidence:
  marker identity, actual child exit signal and recovered record are all required.
* **after-inclusion**: call the original transport once, require CheckTx success,
  query actual inclusion by exact hash, then kill the owner process before the
  response is returned to the engine or a completed observation is saved.
  On-chain sequence/balances must show exactly one operation, not zero or two.

The parent must observe an interrupted HTTP request and the child's `close`
result `{code:null, signal:'SIGKILL'}`. It checks the precise ciphertext and signed
record hashes, not just a label saying a crash occurred. The two cases use
separate actors on one disposable node; there is only **one** included owner
transaction across the pair. Node setup transactions are separate.

## Stale locks and explicit fixture-only reopening

SIGKILL leaves the original PrivateStore `writer.lock` behind. The test starts a
new process against that same directory and **requires rejection** while the
lock inode/content remain unchanged. No stale lock is automatically deleted.

Only after that negative test, the harness copies the **byte-identical current
test ciphertext** into its other new private temporary directory. A new owner
process opens that diagnostic copy. This is an explicit fixture recovery model,
NOT a new product recovery feature, checkpoint recovery, migration procedure or
recommendation to copy a real Vault. The source directory stays locked until all
test processes stop and the disposable fixture is deleted as cleanup.

On reopen, old authentication is rejected, the exact signed transaction and
`SUBMISSION_STARTING` history survive, resubmission is rejected, and unresolved
history prevents a new approval. Before-request remains unknown even after a
404. After-inclusion reconciles to reported-confirmed by stored hash without a
new send. Sequence, gas and base/deposit balances are checked independently.
This does not exercise general expired-unknown retirement or power-loss recovery.

## Execution

Provision the unchanged upstream archive with the existing local provisioner:

```sh
python3 -I integration/injective/provision.py --archive /path/linux-amd64.zip \
  --output /new/private/injective-tools
node --test --test-reporter=tap app/test/owner-crash-addon.test.mjs
node integration/owner-e2e/run-crash.mjs \
  --runtime-dir /path/injective-tools --output /new/outside-source/evidence \
  --expect-commit FULL_COMMIT --expect-tree FULL_TREE
python3 -I integration/owner-e2e/check-crash-evidence.py \
  --directory /path/evidence --expect-commit FULL_COMMIT --expect-tree FULL_TREE
```

The exact commit/tree must be clean; output must be fresh and outside source.
The runner records failures rather than retrying transactions or suppressing
checks. Source snapshots, result, ordered steps and file hashes are bound to the
chosen source. The Python checker rejects duplicate JSON keys, changed/missing
files, malformed counts and scope inflation, including under Python `-O`.
Self-hashes and these software checks are not external attestations or state proofs.

The existing E2E01 five-operation API roundtrip remains available, unchanged.
Neither an API success nor these crash checks is a browser end-to-end pass.
Browser management restrictions are not bypassed; no alternative browser, proxy,
policy modification or security setting is used by this addon.

## Limits and uncompleted gates

Linux and process-level SIGKILL only, not actual hardware power failure, NFS,
Windows, OS compromise, concurrent hostile administrators, public consensus,
public testnet, or product key isolation. The original wallet's cryptography and
storage are unmodified; this is validation of their available INJ12 behavior.
INJ13/checkpoint compatibility and the latest whole-product acceptance remain
unverified. Original full-source runner limits remain unchanged; any timeout
must be reported as a timeout, not combined with another run to fabricate a pass.

Primary execution semantics consulted (pinned Node22.16.0 documentation):
- https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html
  (`close` follows process termination/stdio closure; inspect signal and exit code)
- https://nodejs.org/download/release/v22.16.0/docs/api/fs.html
  (`wx` exclusive create and `fsyncSync`; neither asserts hardware-level durability)
