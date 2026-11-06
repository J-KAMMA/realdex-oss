/**
 * Pure checks a real Stellar Core/Horizon runtime must satisfy before any wallet
 * evidence from it may be believed. No process, container, socket or clock is
 * touched here, so every rule below is testable without a container runtime.
 *
 * These are identity and safety rules, not a pass signal. Satisfying all of them
 * still proves nothing on its own: the caller must have obtained the inputs from a
 * real pinned runtime. A synthetic Horizon can also satisfy these checks, which is
 * exactly why runtime.mjs, not this module, decides whether a gate executed.
 */
import {need} from '../../wallet/lib/guard.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * The container must be running the exact pinned image by digest.
 * A mutable tag alone can never satisfy this, which is the whole point of the pin.
 */
export function verifyRunningImage(inspected, plan) {
  need(inspected && typeof inspected === 'object' && !Array.isArray(inspected), 'STELLAR_INSPECT_INVALID');
  need(typeof plan?.image === 'string' && plan.image.includes('@'), 'STELLAR_PLAN_INVALID');
  const pinnedDigest = plan.image.slice(plan.image.indexOf('@') + 1);
  need(DIGEST.test(pinnedDigest), 'STELLAR_QUICKSTART_IMAGE_DIGEST_NOT_PINNED');
  // Accept only an explicit, full, matching digest. Absent or short means fail.
  need(typeof inspected.imageDigest === 'string' && inspected.imageDigest === pinnedDigest, 'STELLAR_RUNNING_IMAGE_DIGEST_MISMATCH');
  need(inspected.running === true, 'STELLAR_CONTAINER_NOT_RUNNING');
  return pinnedDigest;
}

/**
 * `stellar-core version` must name the pinned version and the pinned base XDR commit.
 *
 * It deliberately does NOT require pin.coreBuild. Measured against the pinned image
 * on 2026-09-09, the build string 28.0.0-3494.a9b861321.noble appears nowhere the
 * container can be asked for it: not in `stellar-core version`, not in dpkg, not in
 * the image labels. Requiring it here would fail every real run, which is worse than
 * useless because it would push someone to weaken the check that does work.
 *
 * The base XDR git version IS printed, per supported protocol, so the pin is checked
 * against the line for the pinned protocol instead. That is a real ledger-format
 * binding rather than a package-naming one.
 */
export function verifyCoreVersion(stdout, pin) {
  need(typeof stdout === 'string' && stdout.length > 0 && stdout.length <= 65536, 'STELLAR_CORE_VERSION_OUTPUT_INVALID');
  need(typeof pin?.coreVersion === 'string' && /^[a-f0-9]{8,64}$/.test(pin?.baseXdrGitVersion ?? ''), 'STELLAR_PIN_INVALID');
  const text = stdout.trim();
  // v28.0.0 must not be satisfied by v28.0.10, so require a non-digit boundary.
  need(new RegExp(pin.coreVersion.replace(/\./g, '\\.') + '(?![0-9.])').test(text), 'STELLAR_CORE_VERSION_MISMATCH');
  need(text.includes('base XDR git version: ' + pin.baseXdrGitVersion), 'STELLAR_CORE_XDR_MISMATCH');
  return text;
}

/**
 * Horizon's reported version must be concrete and self-consistent.
 *
 * It is NOT matched against a semantic version. The pinned image reports `devel`,
 * and the next line of that output is the Go toolchain version, so a semver test
 * passes by matching go1.26.6 — the wrong number entirely. Nothing in pin.json pins
 * a Horizon version, so the honest check is that the CLI and the root document agree.
 */
export function verifyHorizonVersion(stdout, root) {
  need(typeof stdout === 'string' && stdout.length > 0 && stdout.length <= 4096, 'STELLAR_HORIZON_VERSION_OUTPUT_INVALID');
  const reported = stdout.trim().split('\n')[0].trim();
  need(reported.length > 0 && reported.length <= 128, 'STELLAR_HORIZON_VERSION_INVALID');
  if (root !== undefined) {
    need(root && typeof root.horizon_version === 'string', 'STELLAR_HORIZON_VERSION_INVALID');
    need(root.horizon_version === reported, 'STELLAR_HORIZON_VERSION_DISAGREES');
  }
  return reported;
}

/**
 * Horizon's root document must describe the pinned LOCAL network at the pinned protocol.
 * A public network passphrase here is a hard failure, not a warning.
 */
export function verifyHorizonRoot(root, pin) {
  need(root && typeof root === 'object' && !Array.isArray(root), 'STELLAR_ROOT_INVALID');
  need(typeof pin?.networkPassphrase === 'string' && Number.isSafeInteger(pin?.protocolVersion), 'STELLAR_PIN_INVALID');
  need(root.network_passphrase === pin.networkPassphrase, 'STELLAR_NETWORK_PASSPHRASE_MISMATCH');
  need(root.current_protocol_version === pin.protocolVersion, 'STELLAR_PROTOCOL_VERSION_MISMATCH');
  const history = root.history_latest_ledger, core = root.core_latest_ledger;
  need(Number.isSafeInteger(history) && history >= 1, 'STELLAR_HISTORY_LEDGER_INVALID');
  need(Number.isSafeInteger(core) && core >= history, 'STELLAR_CORE_LEDGER_INVALID');
  return {historyLedger: history, coreLedger: core};
}

/** Horizon must be bound to loopback only. A routable host would expose a test ledger. */
export function verifyLoopbackOnly(plan) {
  need(plan?.host === '127.0.0.1', 'STELLAR_HOST_NOT_LOOPBACK');
  need(typeof plan.horizonUrl === 'string' && plan.horizonUrl.startsWith('http://127.0.0.1:'), 'STELLAR_HORIZON_URL_NOT_LOOPBACK');
  need(typeof plan.friendbotUrl === 'string' && plan.friendbotUrl.startsWith('http://127.0.0.1:'), 'STELLAR_FRIENDBOT_URL_NOT_LOOPBACK');
  need(plan.publicNetworkAllowed === false && plan.autoPullAllowed === false && plan.persistentVolumeAllowed === false, 'STELLAR_PLAN_POLICY');
  return true;
}

/**
 * The no-resend rule, stated against what the real ledger shows.
 *
 * After a lost submit response the wallet holds a durable `broadcast-unknown`
 * record. Recovery is reconcile-only: a second broadcast must have been refused,
 * and the ledger must contain exactly one payment for that transaction hash. Two
 * payments mean the wallet resent, which is the failure this gate exists to catch.
 */
export function verifyNoResendReconciliation({recordStates, rebroadcastError, ledgerPayments, transactionHash} = {}) {
  need(Array.isArray(recordStates) && recordStates.length >= 2, 'STELLAR_RECORD_STATES_REQUIRED');
  need(typeof transactionHash === 'string' && /^[a-f0-9]{64}$/.test(transactionHash), 'STELLAR_TRANSACTION_HASH_INVALID');
  // The durable unknown state must exist before the outcome is known.
  need(recordStates.includes('broadcast-unknown'), 'STELLAR_DURABLE_UNKNOWN_STATE_MISSING');
  // Re-broadcast must have been refused, not silently retried.
  need(rebroadcastError === 'ACCOUNT_REBROADCAST_NOT_IMPLEMENTED', 'STELLAR_RESEND_NOT_REFUSED');
  need(Array.isArray(ledgerPayments), 'STELLAR_LEDGER_PAYMENTS_REQUIRED');
  const matching = ledgerPayments.filter(p => p && p.transaction_hash === transactionHash);
  need(matching.length === 1, 'STELLAR_PAYMENT_NOT_EXACTLY_ONCE');
  // The terminal state must be a reported outcome reached by reconciling, not by resending.
  const terminal = recordStates[recordStates.length - 1];
  need(terminal === 'reported-confirmed' || terminal === 'reported-reverted', 'STELLAR_RECONCILIATION_NOT_TERMINAL');
  return {payments: matching.length, terminal};
}
