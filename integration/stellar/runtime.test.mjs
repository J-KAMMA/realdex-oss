/**
 * Control-flow tests for the Stellar runtime driver.
 *
 * These use injected exec/httpGet doubles. That makes them tests of THIS
 * module's decisions — ordering, refusals, teardown — and explicitly NOT
 * evidence that a real Stellar Core ran. A synthetic double must never be able
 * to stand in for the runtime gate, so nothing here asserts a gate pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {requireLocalImage, stellarRuntimeIdentity, verifiedContainerRuntime} from './runtime.mjs';
import {STELLAR_QUICKSTART_PIN} from './toolchain.mjs';

const DIGEST = 'sha256:' + '6'.repeat(64);
const OTHER = 'sha256:' + '7'.repeat(64);
const PIN = {...STELLAR_QUICKSTART_PIN, quickstartImageDigest: DIGEST};
const IMAGE = PIN.quickstartImage + '@' + DIGEST;
const throws = (fn, code) => assert.throws(fn, e => e.message === code, 'expected ' + code);
const rejects = (p, code) => assert.rejects(p, e => e.message === code, 'expected ' + code);

let runtimeFile;
test.before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realdex-stellar-runtime-'));
  runtimeFile = path.join(dir, 'podman');
  fs.writeFileSync(runtimeFile, '#!/bin/sh\n', {mode: 0o755});
});

const ROOT = {
  network_passphrase: PIN.networkPassphrase, current_protocol_version: PIN.protocolVersion,
  history_latest_ledger: 7, core_latest_ledger: 7, horizon_version: 'devel',
};
// Captured verbatim from the pinned image on 2026-09-09.
const CORE = ['v28.0.1', 'ledger protocol version: 28', '    host[7]:',
  '        ledger protocol version: 28',
  '            base XDR git version: 9c9c145953e80990d6ff1ae3a6a973a0ce6d0694'].join('\n');
const HORIZON = 'devel\ngo1.26.6';

/** A double that records the command sequence and answers the happy path. */
function harness(over = {}) {
  const calls = [];
  const exec = async args => {
    calls.push(args.join(' '));
    const reply = over.exec?.(args);
    if (reply !== undefined) return reply;
    if (args[0] === 'image' && args[1] === 'inspect') return {status: 0, stdout: DIGEST + '\n'};
    if (args[0] === 'run') return {status: 0, stdout: 'container-id\n'};
    if (args[0] === 'inspect') return {status: 0, stdout: JSON.stringify({ImageDigest: DIGEST, State: {Running: true}})};
    if (args.includes('stellar-core')) return {status: 0, stdout: CORE};
    if (args.includes('stellar-horizon')) return {status: 0, stdout: HORIZON};
    if (args[0] === 'rm') return {status: 0, stdout: ''};
    return {status: 0, stdout: ''};
  };
  const httpGet = over.httpGet ?? (async () => ({ok: true, json: ROOT}));
  return {calls, run: () => stellarRuntimeIdentity({
    containerRuntime: runtimeFile, exec, httpGet, pin: PIN, attempts: 3, ...over.options,
  })};
}

test('a verified container runtime must be a real, non-writable executable', () => {
  assert.equal(verifiedContainerRuntime(runtimeFile), runtimeFile);
  throws(() => verifiedContainerRuntime(''), 'STELLAR_CONTAINER_RUNTIME_NOT_CONFIGURED');
  throws(() => verifiedContainerRuntime(undefined), 'STELLAR_CONTAINER_RUNTIME_NOT_CONFIGURED');
});

test('a group- or other-writable runtime binary is refused', () => {
  const loose = runtimeFile + '-loose';
  fs.writeFileSync(loose, '#!/bin/sh\n', {mode: 0o757});
  fs.chmodSync(loose, 0o757);
  throws(() => verifiedContainerRuntime(loose), 'STELLAR_CONTAINER_RUNTIME_UNSAFE');
});

test('a missing local image is refused and never pulled', async () => {
  const exec = async args => {
    assert.notEqual(args[0], 'pull', 'the driver must never pull');
    return {status: 1, stdout: '', stderr: 'no such image'};
  };
  await rejects(requireLocalImage(exec, {image: IMAGE}), 'STELLAR_IMAGE_NOT_PRESENT_LOCALLY');
});

test('a local image whose digest differs from the pin is refused', async () => {
  const exec = async () => ({status: 0, stdout: OTHER});
  await rejects(requireLocalImage(exec, {image: IMAGE}), 'STELLAR_LOCAL_IMAGE_DIGEST_MISMATCH');
});

test('the happy path checks the image before it reports anything, and tears down', async () => {
  const h = harness();
  const evidence = await h.run();
  assert.equal(evidence.executed, true);
  assert.equal(evidence.imageDigest, DIGEST);
  assert.equal(evidence.networkPassphrase, PIN.networkPassphrase);
  assert.equal(evidence.protocolVersion, PIN.protocolVersion);
  assert.equal(evidence.paymentPerformed, false);
  assert.equal(evidence.publicNetworkContacted, false);
  assert.equal(evidence.productionApproved, false);
  // Image identity is inspected before the versions are believed, and rm always runs.
  const inspectAt = h.calls.findIndex(c => c.startsWith('inspect '));
  const coreAt = h.calls.findIndex(c => c.includes('stellar-core'));
  assert.ok(inspectAt >= 0 && coreAt > inspectAt, 'identity must be checked before versions');
  assert.ok(h.calls.some(c => c.startsWith('rm ')), 'the container must be removed');
  assert.ok(!h.calls.some(c => c.startsWith('pull')), 'the driver must never pull');
});

test('a container running a different image fails and is still torn down', async () => {
  const h = harness({exec: args => args[0] === 'inspect'
    ? {status: 0, stdout: JSON.stringify({ImageDigest: OTHER, State: {Running: true}})} : undefined});
  await rejects(h.run(), 'STELLAR_RUNNING_IMAGE_DIGEST_MISMATCH');
  assert.ok(h.calls.some(c => c.startsWith('rm ')), 'teardown must happen after a failed check');
});

test('a horizon that never becomes ready fails rather than hanging', async () => {
  const h = harness({httpGet: async () => ({ok: false})});
  await rejects(h.run(), 'STELLAR_HORIZON_NOT_READY');
  assert.ok(h.calls.some(c => c.startsWith('rm ')), 'teardown must happen after a timeout');
});

test('a horizon reporting the public network fails on the passphrase, not on a vague timeout', async () => {
  // It answers, so readiness is satisfied; the refusal must name the real reason.
  const h = harness({httpGet: async () => ({ok: true,
    json: {...ROOT, network_passphrase: 'Public Global Stellar Network ; September 2015'}})});
  await rejects(h.run(), 'STELLAR_NETWORK_PASSPHRASE_MISMATCH');
  assert.ok(h.calls.some(c => c.startsWith('rm ')), 'teardown must happen after a rejected network');
});

test('a core reporting a different version than the pin fails', async () => {
  const h = harness({exec: args => args.includes('stellar-core')
    ? {status: 0, stdout: CORE.replace('v28.0.1', 'v27.1.0')} : undefined});
  await rejects(h.run(), 'STELLAR_CORE_VERSION_MISMATCH');
});

test('a core built against a different base XDR commit fails', async () => {
  const h = harness({exec: args => args.includes('stellar-core')
    ? {status: 0, stdout: CORE.replace('9c9c145953e8', 'deadbeef1234')} : undefined});
  await rejects(h.run(), 'STELLAR_CORE_XDR_MISMATCH');
});

test('a failed container start is reported and does not leave a teardown claim', async () => {
  const h = harness({exec: args => args[0] === 'run' ? {status: 125, stdout: '', stderr: 'boom'} : undefined});
  await rejects(h.run(), 'STELLAR_EXEC_FAILED');
  assert.ok(!h.calls.some(c => c.startsWith('rm ')), 'nothing was started, so nothing is removed');
});

test('the driver refuses to run when the digest is not pinned', async () => {
  await rejects(stellarRuntimeIdentity({
    containerRuntime: runtimeFile, exec: async () => ({status: 0, stdout: ''}),
    httpGet: async () => ({ok: true, json: ROOT}),
    pin: {...STELLAR_QUICKSTART_PIN, quickstartImageDigest: null},
  }), 'STELLAR_QUICKSTART_IMAGE_DIGEST_NOT_PINNED');
});

test('the committed pin really does carry a digest now', () => {
  assert.match(STELLAR_QUICKSTART_PIN.quickstartImageDigest, /^sha256:[a-f0-9]{64}$/);
});
