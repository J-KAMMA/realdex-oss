/**
 * The real Stellar Core/Horizon runtime gate.
 *
 * Requires REALDEX_STELLAR_CONTAINER_RUNTIME and the pinned image already present
 * locally. It starts the container itself, checks identity before believing any
 * observation, funds disposable accounts through the container's own Friendbot,
 * moves real XLM through the wallet's ordinary Stellar path, then loses a submit
 * response and proves the recovery is reconcile-only with exactly one payment on
 * the real ledger.
 *
 * Passing here is real-runtime evidence for THIS commit. It is not production
 * approval, and it touches no public network: stellar-offline.mjs refuses to sign
 * for anything but the standalone passphrase the pin names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stellarQuickstartRunPlan} from './runtime-plan.mjs';
import {STELLAR_QUICKSTART_PIN} from './toolchain.mjs';
import {verifiedContainerRuntime, requireLocalImage} from './runtime.mjs';
import {verifyRunningImage, verifyCoreVersion, verifyHorizonVersion, verifyHorizonRoot, verifyLoopbackOnly, verifyNoResendReconciliation} from './runtime-checks.mjs';
import {realStellarWalletFixture} from './wallet-fixture.mjs';

const run = promisify(execFile);
const NAME = 'realdex-stellar-acceptance';
const HOST_PORT = 18042;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const runtime = verifiedContainerRuntime(process.env.REALDEX_STELLAR_CONTAINER_RUNTIME);
const plan = stellarQuickstartRunPlan({name: NAME, hostPort: HOST_PORT});
const exec = async args => {
  try { const {stdout} = await run(runtime, args, {maxBuffer: 1 << 24, timeout: 120000}); return {status: 0, stdout}; }
  catch (error) { return {status: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? ''}; }
};

test('real Stellar Core runtime: identity, a real XLM payment, and no-resend recovery', async t => {
  verifyLoopbackOnly(plan);
  await requireLocalImage(exec, plan);
  await exec(['rm', '--force', NAME]);

  const started = await exec(plan.runArgs);
  assert.equal(started.status, 0, 'the pinned container must start: ' + (started.stderr ?? ''));
  t.after(async () => { await exec(plan.stopArgs); });

  let root = null;
  let lastAnswer = 'no answer at all';
  for (let i = 0; i < 120 && root === null; i++) {
    try {
      const response = await fetch(plan.horizonUrl, {signal: AbortSignal.timeout(4000)});
      if (response.ok) {
        const parsed = await response.json();
        // Not merely answering: Horizon must have ingested, or it can serve nothing.
        if (parsed?.network_passphrase && Number(parsed.history_latest_ledger) >= 2) root = parsed;
        else lastAnswer = 'answering, history_latest_ledger ' + parsed?.history_latest_ledger + ', core_latest_ledger ' + parsed?.core_latest_ledger;
      } else lastAnswer = 'HTTP ' + response.status;
    } catch (error) { lastAnswer = String(error?.message ?? error).slice(0, 120); }
    if (root === null) await delay(5000);
  }
  if (root === null) {
    // Ten minutes of waiting and then "must become ready" tells whoever reads the run
    // nothing about which of Core, Horizon or Postgres did not arrive. The container is
    // still up at this point — t.after removes it — so ask it before it goes. Twice in
    // twelve back-to-back runs it never ingested, and there was nothing left to look at.
    const inspected = await exec(['inspect', NAME, '--format', '{{.State.Status}} exit={{.State.ExitCode}}']);
    const logs = await exec(['logs', '--tail', '40', NAME]);
    assert.fail('Horizon must become ready and ingest. Last answer: ' + lastAnswer +
      '\ncontainer: ' + (inspected.stdout || inspected.stderr || '(no state)').trim() +
      '\n--- last 40 log lines ---\n' + ((logs.stdout || '') + (logs.stderr || '')).slice(-4000));
  }

  await t.test('the running container is the pinned image at the pinned protocol', async () => {
    const inspected = JSON.parse((await exec(['inspect', NAME, '--format', '{{json .}}'])).stdout);
    verifyRunningImage({imageDigest: inspected.ImageDigest, running: inspected?.State?.Running === true}, plan);
    verifyCoreVersion((await exec(plan.coreVersionArgs)).stdout, STELLAR_QUICKSTART_PIN);
    verifyHorizonVersion((await exec(plan.horizonVersionArgs)).stdout, root);
    const ledgers = verifyHorizonRoot(root, STELLAR_QUICKSTART_PIN);
    assert.ok(ledgers.historyLedger >= 2);
  });

  const wallet = await realStellarWalletFixture({
    horizonUrl: plan.horizonUrl, friendbotUrl: plan.friendbotUrl,
    sourceSecretHex: '31'.repeat(32), recipientSecretHex: '32'.repeat(32),
  });
  t.after(() => wallet.close());

  await t.test('the wallet moves real XLM on the real ledger', async () => {
    const record = await wallet.pay();
    assert.ok(record?.signed?.requestId, "pay must return a record with signed.requestId");
    assert.equal(record.state, 'broadcast');
    // A ledger has to close first, so reconcile until the outcome is reported.
    let reconciled;
    for (let i = 0; i < 30; i++) {
      reconciled = await wallet.reconcile(record);
      if (reconciled.state !== 'broadcast' && reconciled.state !== 'broadcast-unknown') break;
      await delay(2000);
    }
    assert.equal(reconciled.state, 'reported-confirmed');
    assert.equal(reconciled.report.received, true);
    // Horizon observation is not a finality proof and the wallet must not claim one.
    assert.equal(reconciled.report.finalityProven, false);
    const payments = await wallet.ledgerPayments();
    assert.equal(payments.length, 1, 'exactly one payment must exist on the real ledger');
  });

  await t.test('a lost submit response recovers by reconciling, and never resends', async () => {
    const before = (await wallet.ledgerPayments()).length;
    wallet.fault.dropSubmitResponse = true;
    const record = await wallet.pay();
    assert.ok(record?.signed?.requestId, "pay must return a record with signed.requestId");
    wallet.fault.dropSubmitResponse = false;

    // The durable record must record the unknown outcome, not a guess either way.
    assert.equal(record.state, 'broadcast-unknown');
    const states = ['signed', record.state];

    // Recovery is reconcile-only: a second submit must be refused outright.
    let rebroadcastError;
    try { await wallet.submit(record); } catch (error) { rebroadcastError = error.message; }
    assert.equal(rebroadcastError, 'ACCOUNT_REBROADCAST_NOT_IMPLEMENTED');

    let reconciled;
    for (let i = 0; i < 30; i++) {
      reconciled = await wallet.reconcile(record);
      if (reconciled.state !== 'broadcast-unknown') break;
      await delay(2000);
    }
    states.push(reconciled.state);
    assert.equal(reconciled.state, 'reported-confirmed');

    const payments = await wallet.ledgerPayments();
    assert.equal(payments.length, before + 1, 'the lost response must not have produced a second payment');
    // Stellar records carry the transaction hash as signed.requestId.
    const hash = record.signed.requestId;
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(verifyNoResendReconciliation({
      recordStates: states, rebroadcastError,
      ledgerPayments: payments, transactionHash: hash,
    }), {payments: 1, terminal: 'reported-confirmed'});
  });
});
