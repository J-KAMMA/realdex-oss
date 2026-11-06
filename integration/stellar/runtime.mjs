/**
 * Stellar Core/Horizon local runtime driver.
 *
 * Everything that decides whether the runtime may be trusted lives here as
 * injectable control flow: the caller supplies `exec` and `httpGet`, so the
 * ordering, the refusals and the teardown are all testable without a container.
 * The real caller passes a process spawner and fetch.
 *
 * Two rules shape the design:
 *   - The image is NEVER pulled here. A missing image is a refusal, not a
 *     download, because a pull is the one step that could substitute a
 *     different image for the pinned one.
 *   - Identity is checked BEFORE any observation is believed, and the container
 *     is torn down whether or not the checks passed.
 *
 * Returning evidence from this module is not a gate pass. `executed` only
 * describes what this driver did; whether that counts is decided by the caller,
 * which must have obtained a verified container runtime first.
 */
import fs from 'node:fs';
import path from 'node:path';
import {need} from '../../wallet/lib/guard.mjs';
import {stellarQuickstartRunPlan} from './runtime-plan.mjs';
import {STELLAR_QUICKSTART_PIN} from './toolchain.mjs';
import {verifyRunningImage, verifyCoreVersion, verifyHorizonVersion, verifyHorizonRoot, verifyLoopbackOnly} from './runtime-checks.mjs';

/** The runtime must be a real, non-symlinked, non-group/other-writable executable. */
export function verifiedContainerRuntime(input) {
  need(typeof input === 'string' && input.length > 0, 'STELLAR_CONTAINER_RUNTIME_NOT_CONFIGURED');
  const file = path.resolve(input), stat = fs.lstatSync(file);
  need(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0, 'STELLAR_CONTAINER_RUNTIME_UNSAFE');
  fs.accessSync(file, fs.constants.X_OK);
  return file;
}

const ok = result => {
  need(result && typeof result === 'object', 'STELLAR_EXEC_RESULT_INVALID');
  need(result.status === 0 && !result.signal, 'STELLAR_EXEC_FAILED');
  return typeof result.stdout === 'string' ? result.stdout : '';
};

/**
 * Confirms the pinned image is ALREADY present locally, by digest.
 * Deliberately no pull: `autoPullAllowed` is false in the pin and staying that
 * way is the difference between a pinned image and whatever the registry serves.
 */
export async function requireLocalImage(exec, plan) {
  need(typeof exec === 'function', 'STELLAR_EXEC_REQUIRED');
  const pinnedDigest = plan.image.slice(plan.image.indexOf('@') + 1);
  let inspected;
  try {
    inspected = ok(await exec(['image', 'inspect', plan.image, '--format', '{{.Digest}}'])).trim();
  } catch {
    // A missing image is a refusal. The caller pre-fetches it under review.
    throw Error('STELLAR_IMAGE_NOT_PRESENT_LOCALLY');
  }
  need(inspected === pinnedDigest, 'STELLAR_LOCAL_IMAGE_DIGEST_MISMATCH');
  return pinnedDigest;
}

/**
 * Starts the pinned container, checks its identity and versions, and tears it
 * down again. Returns preflight-and-identity evidence only; it deliberately
 * performs no payment, so it can never be mistaken for the wallet gate.
 */
export async function stellarRuntimeIdentity({
  containerRuntime, exec, httpGet, name = 'realdex-stellar-acceptance', hostPort = 8000,
  pin = STELLAR_QUICKSTART_PIN, attempts = 120, wait = async () => {},
} = {}) {
  const runtime = verifiedContainerRuntime(containerRuntime);
  const plan = stellarQuickstartRunPlan({pin, name, hostPort});
  verifyLoopbackOnly(plan);
  need(typeof exec === 'function' && typeof httpGet === 'function', 'STELLAR_EXEC_REQUIRED');
  need(Number.isSafeInteger(attempts) && attempts > 0, 'STELLAR_ATTEMPTS_INVALID');
  const pinnedDigest = await requireLocalImage(exec, plan);

  let started = false;
  try {
    ok(await exec(plan.runArgs));
    started = true;

    let root = null;
    for (let i = 0; i < attempts && root === null; i++) {
      try {
        const response = await httpGet(plan.horizonUrl);
        if (response && response.ok && response.json && response.json.network_passphrase) root = response.json;
      } catch { /* Horizon is not up yet; keep waiting rather than failing early. */ }
      if (root === null) await wait();
    }
    need(root !== null, 'STELLAR_HORIZON_NOT_READY');

    // Identity first: nothing observed above is trusted until the image matches.
    const inspected = JSON.parse(ok(await exec(['inspect', name, '--format', '{{json .}}'])));
    verifyRunningImage({imageDigest: inspected.ImageDigest, running: inspected?.State?.Running === true}, plan);

    const ledgers = verifyHorizonRoot(root, plan.pinUsed ?? pin);
    const core = verifyCoreVersion(ok(await exec(plan.coreVersionArgs)), pin);
    const horizon = verifyHorizonVersion(ok(await exec(plan.horizonVersionArgs)), root);

    return Object.freeze({
      schema: 'realdex.stellar-runtime-identity.v1',
      executed: true, containerRuntime: runtime,
      image: plan.image, imageDigest: pinnedDigest,
      coreVersion: core, horizonVersion: horizon,
      networkPassphrase: root.network_passphrase, protocolVersion: root.current_protocol_version,
      ...ledgers,
      horizonUrl: plan.horizonUrl, friendbotUrl: plan.friendbotUrl,
      publicNetworkContacted: false, paymentPerformed: false,
      productionApproved: false,
    });
  } finally {
    // Ephemeral by contract: tear down even when a check above threw.
    if (started) { try { await exec(plan.stopArgs); } catch { /* already gone */ } }
  }
}
