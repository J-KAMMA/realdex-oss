import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyRunningImage, verifyCoreVersion, verifyHorizonVersion,
  verifyHorizonRoot, verifyLoopbackOnly, verifyNoResendReconciliation,
} from './runtime-checks.mjs';
import {STELLAR_QUICKSTART_PIN} from './toolchain.mjs';

const DIGEST = 'sha256:' + '8'.repeat(64);
const OTHER = 'sha256:' + '9'.repeat(64);
const PIN = {...STELLAR_QUICKSTART_PIN, quickstartImageDigest: DIGEST};
const plan = (over = {}) => ({
  image: 'stellar/quickstart:v657-b1330.1-latest@' + DIGEST,
  host: '127.0.0.1', horizonUrl: 'http://127.0.0.1:8000/', friendbotUrl: 'http://127.0.0.1:8000/friendbot',
  publicNetworkAllowed: false, autoPullAllowed: false, persistentVolumeAllowed: false, ...over,
});
const throws = (fn, code) => assert.throws(fn, e => e.message === code, 'expected ' + code);

test('the running container must match the pinned digest exactly', () => {
  assert.equal(verifyRunningImage({imageDigest: DIGEST, running: true}, plan()), DIGEST);
  throws(() => verifyRunningImage({imageDigest: OTHER, running: true}, plan()), 'STELLAR_RUNNING_IMAGE_DIGEST_MISMATCH');
  throws(() => verifyRunningImage({running: true}, plan()), 'STELLAR_RUNNING_IMAGE_DIGEST_MISMATCH');
  throws(() => verifyRunningImage({imageDigest: DIGEST, running: false}, plan()), 'STELLAR_CONTAINER_NOT_RUNNING');
});

test('a mutable tag with no digest can never satisfy the image check', () => {
  throws(() => verifyRunningImage({imageDigest: DIGEST, running: true},
    {image: 'stellar/quickstart:v657-b1330.1-latest'}), 'STELLAR_PLAN_INVALID');
  throws(() => verifyRunningImage({imageDigest: 'sha256:abc', running: true},
    {image: 'stellar/quickstart:latest@sha256:abc'}), 'STELLAR_QUICKSTART_IMAGE_DIGEST_NOT_PINNED');
});

// Captured verbatim from the pinned image on 2026-09-09, trimmed to the lines checked.
const REAL_CORE_VERSION = [
  'v28.0.1',
  'ledger protocol version: 28',
  'rust version: rustc 1.95.0 (59807616e 2026-04-14)',
  'soroban-env-host versions: ',
  '    host[6]:',
  '        ledger protocol version: 27',
  '            base XDR git version: 68fa1ac55692f68ad2a2ca549d0a283273554439',
  '    host[7]:',
  '        ledger protocol version: 28',
  '            base XDR git version: 9c9c145953e80990d6ff1ae3a6a973a0ce6d0694',
].join('\n');
const REAL_HORIZON_VERSION = 'devel\ngo1.26.6\n';

test('core version accepts the real pinned-image output', () => {
  assert.ok(verifyCoreVersion(REAL_CORE_VERSION, PIN).length > 0);
  throws(() => verifyCoreVersion('', PIN), 'STELLAR_CORE_VERSION_OUTPUT_INVALID');
});

test('core version binds the pinned base XDR commit, which the image really prints', () => {
  const wrongXdr = REAL_CORE_VERSION.replace('9c9c145953e8', 'deadbeef1234');
  throws(() => verifyCoreVersion(wrongXdr, PIN), 'STELLAR_CORE_XDR_MISMATCH');
});

test('a longer version number must not satisfy the pinned one by prefix', () => {
  // v28.0.1 must not be accepted by v28.0.11.
  throws(() => verifyCoreVersion(REAL_CORE_VERSION.replace('v28.0.1\n', 'v28.0.11\n'), PIN),
    'STELLAR_CORE_VERSION_MISMATCH');
});

test('horizon version takes the first line and must agree with the root document', () => {
  // The real image reports `devel`, and the SECOND line is the Go toolchain version.
  assert.equal(verifyHorizonVersion(REAL_HORIZON_VERSION), 'devel');
  assert.equal(verifyHorizonVersion(REAL_HORIZON_VERSION, {horizon_version: 'devel'}), 'devel');
  throws(() => verifyHorizonVersion(REAL_HORIZON_VERSION, {horizon_version: 'devel-other'}),
    'STELLAR_HORIZON_VERSION_DISAGREES');
  throws(() => verifyHorizonVersion(''), 'STELLAR_HORIZON_VERSION_OUTPUT_INVALID');
});

test('the go toolchain version must not be mistaken for the horizon version', () => {
  // Guards the defect this check was written to fix: a bare semver test on the whole
  // output matches go1.26.6 and reports success for a Horizon that named no version.
  assert.notEqual(verifyHorizonVersion(REAL_HORIZON_VERSION), 'go1.26.6');
});

test('horizon root must describe the pinned local network at the pinned protocol', () => {
  const root = {network_passphrase: PIN.networkPassphrase, current_protocol_version: 28, history_latest_ledger: 12, core_latest_ledger: 12};
  assert.deepEqual(verifyHorizonRoot(root, PIN), {historyLedger: 12, coreLedger: 12});
  throws(() => verifyHorizonRoot({...root, current_protocol_version: 27}, PIN), 'STELLAR_PROTOCOL_VERSION_MISMATCH');
  throws(() => verifyHorizonRoot({...root, core_latest_ledger: 11}, PIN), 'STELLAR_CORE_LEDGER_INVALID');
});

test('the public network passphrase is a hard failure', () => {
  const root = {network_passphrase: 'Public Global Stellar Network ; September 2015',
    current_protocol_version: 28, history_latest_ledger: 5, core_latest_ledger: 5};
  throws(() => verifyHorizonRoot(root, PIN), 'STELLAR_NETWORK_PASSPHRASE_MISMATCH');
});

test('horizon and friendbot must be loopback only and the policy flags must hold', () => {
  assert.equal(verifyLoopbackOnly(plan()), true);
  throws(() => verifyLoopbackOnly(plan({host: '0.0.0.0'})), 'STELLAR_HOST_NOT_LOOPBACK');
  throws(() => verifyLoopbackOnly(plan({horizonUrl: 'http://10.0.0.4:8000/'})), 'STELLAR_HORIZON_URL_NOT_LOOPBACK');
  throws(() => verifyLoopbackOnly(plan({autoPullAllowed: true})), 'STELLAR_PLAN_POLICY');
  throws(() => verifyLoopbackOnly(plan({persistentVolumeAllowed: true})), 'STELLAR_PLAN_POLICY');
});

const HASH = 'a'.repeat(64);
const payment = (h = HASH) => ({transaction_hash: h, type: 'payment'});
const reconciled = (over = {}) => ({
  recordStates: ['signed', 'broadcast-unknown', 'reported-confirmed'],
  rebroadcastError: 'ACCOUNT_REBROADCAST_NOT_IMPLEMENTED',
  ledgerPayments: [payment()], transactionHash: HASH, ...over,
});

test('a lost response reconciles to exactly one on-ledger payment', () => {
  assert.deepEqual(verifyNoResendReconciliation(reconciled()), {payments: 1, terminal: 'reported-confirmed'});
});

test('a resent payment is caught by the exactly-once ledger check', () => {
  throws(() => verifyNoResendReconciliation(reconciled({ledgerPayments: [payment(), payment()]})),
    'STELLAR_PAYMENT_NOT_EXACTLY_ONCE');
});

test('a payment that never reached the ledger is not a reconciliation', () => {
  throws(() => verifyNoResendReconciliation(reconciled({ledgerPayments: []})), 'STELLAR_PAYMENT_NOT_EXACTLY_ONCE');
});

test('the durable unknown state must have existed before the outcome', () => {
  throws(() => verifyNoResendReconciliation(reconciled({recordStates: ['signed', 'reported-confirmed']})),
    'STELLAR_DURABLE_UNKNOWN_STATE_MISSING');
});

test('a wallet that allowed a second broadcast fails the gate', () => {
  throws(() => verifyNoResendReconciliation(reconciled({rebroadcastError: undefined})), 'STELLAR_RESEND_NOT_REFUSED');
  throws(() => verifyNoResendReconciliation(reconciled({rebroadcastError: 'SOMETHING_ELSE'})), 'STELLAR_RESEND_NOT_REFUSED');
});

test('the run must end in a reported outcome, not back in an unknown state', () => {
  throws(() => verifyNoResendReconciliation(reconciled({recordStates: ['signed', 'broadcast-unknown']})),
    'STELLAR_RECONCILIATION_NOT_TERMINAL');
});

test('a reported revert is a valid terminal outcome', () => {
  assert.deepEqual(
    verifyNoResendReconciliation(reconciled({recordStates: ['signed', 'broadcast-unknown', 'reported-reverted']})),
    {payments: 1, terminal: 'reported-reverted'});
});

test('malformed inputs are rejected rather than treated as success', () => {
  throws(() => verifyNoResendReconciliation({}), 'STELLAR_RECORD_STATES_REQUIRED');
  throws(() => verifyNoResendReconciliation(reconciled({transactionHash: 'nope'})), 'STELLAR_TRANSACTION_HASH_INVALID');
  throws(() => verifyNoResendReconciliation(reconciled({ledgerPayments: undefined})), 'STELLAR_LEDGER_PAYMENTS_REQUIRED');
});
