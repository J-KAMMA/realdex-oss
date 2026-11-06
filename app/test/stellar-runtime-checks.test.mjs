/**
 * Brings the Stellar real-runtime rules into the app-tests gate.
 *
 * The rules live next to the runtime code in integration/stellar/ but nothing globs
 * that directory, so without this wrapper they would never run. They are pure and
 * need no container, which is why they belong in app-tests rather than behind the
 * still-blocked stellar-core-runtime gate.
 *
 * Importing the suite rather than restating it keeps the two from drifting apart.
 */
import '../../integration/stellar/runtime-checks.test.mjs';
import '../../integration/stellar/runtime.test.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import {STELLAR_QUICKSTART_PIN} from '../../integration/stellar/toolchain.mjs';

test('the runtime driver is groundwork only: it proves identity, never a payment', async () => {
  // stellar-core-runtime must not become passable on identity alone. The gate also
  // owes a real XLM payment and the no-resend reconciliation, which are not written
  // yet, so nothing here may be wired into that gate.
  const {stellarRuntimeIdentity} = await import('../../integration/stellar/runtime.mjs');
  assert.equal(typeof stellarRuntimeIdentity, 'function');
  const source = await import('node:fs').then(fs => fs.readFileSync(
    new URL('../../integration/stellar/runtime.mjs', import.meta.url), 'utf8'));
  assert.match(source, /paymentPerformed: false/);
});

test('the committed Stellar pin names a full immutable digest and stays local and test-only', () => {
  assert.match(STELLAR_QUICKSTART_PIN.quickstartImageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(STELLAR_QUICKSTART_PIN.autoPullAllowed, false);
  assert.equal(STELLAR_QUICKSTART_PIN.publicNetworkAllowed, false);
  assert.equal(STELLAR_QUICKSTART_PIN.testOnly, true);
  assert.equal(STELLAR_QUICKSTART_PIN.mode, 'local');
});

test('the pinned image must be one whose Horizon can serve the pinned protocol', () => {
  // v657 pinned protocol 28 against a Horizon that supports 27, so it could never
  // ingest and the gate could never pass. Keep the two facts tied together.
  assert.equal(STELLAR_QUICKSTART_PIN.protocolVersion, 28);
  assert.notEqual(STELLAR_QUICKSTART_PIN.quickstartImage, 'stellar/quickstart:v657-b1330.1-latest');
  assert.match(STELLAR_QUICKSTART_PIN.source?.runtimeVerification ?? '', /supported_protocol_version 28/);
});
