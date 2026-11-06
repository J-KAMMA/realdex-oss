import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet, getAddress} from 'ethers';
import {
  RELEASE_ATTESTATION_SCHEMA, RELEASE_STAMP_PATH,
  releaseAttestationPayload, parseUnsignedReleaseAttestation, parseReleaseAttestation, verifyReleaseDistribution,
  reviewReleaseUpdate, releaseAttestationFreshness,
} from '../lib/release-attestation.mjs';

// Deterministic and disposable. Nothing here is an approved signer and no key of the
// owner's is loaded, read or written by this suite.
const signer = new Wallet('0x' + '11'.repeat(32));
const other = new Wallet('0x' + '22'.repeat(32));
const hash = n => 'sha256:' + String(n).repeat(64).slice(0, 64);

const unsigned = () => ({
  schema: RELEASE_ATTESTATION_SCHEMA,
  releaseId: 'base-sepolia-c052e1d9f8a4',
  bundleSha256: hash(1),
  sequence: '7',
  builtAt: 1757000000000,
  validUntil: 1757000000000 + 90 * 86400000,
  distribution: {
    'index.html': hash(2),
    'release-id.txt': hash(3),
    'assets/index-AbC0.js': hash(4),
    'assets/index-AbC0.css': hash(5),
  },
});
const sign = async (value = unsigned(), by = signer) =>
  ({...value, signerAddress: getAddress(by.address), signature: await by.signMessage(releaseAttestationPayload(value))});
const observedFrom = value => ({...value.distribution});
const rejects = (fn, code) => assert.throws(fn, error => error.message === code, 'expected ' + code);

test('The payload is ordered and counted, so a reordering is not the same statement', () => {
  const a = unsigned();
  const b = {...a, distribution: Object.fromEntries(Object.entries(a.distribution).reverse())};
  assert.equal(releaseAttestationPayload(a), releaseAttestationPayload(b));
  const lines = releaseAttestationPayload(a).trimEnd().split('\n');
  assert.equal(lines[0], 'RealDEX release attestation v1');
  assert.equal(lines[3], '7', 'the sequence is part of what is signed, or a replay is indistinguishable');
  assert.equal(lines[6], '4', 'the file count is part of what is signed');
  assert.deepEqual(lines.slice(7), [
    'assets/index-AbC0.css ' + hash(5),
    'assets/index-AbC0.js ' + hash(4),
    'index.html ' + hash(2),
    'release-id.txt ' + hash(3),
  ]);
});

test('Dropping a file from the list changes what was signed', () => {
  const a = unsigned(), b = unsigned();
  delete b.distribution['assets/index-AbC0.css'];
  assert.notEqual(releaseAttestationPayload(a), releaseAttestationPayload(b));
});

test('An attestation that does not cover the release stamp is refused', () => {
  const value = unsigned();
  delete value.distribution[RELEASE_STAMP_PATH];
  rejects(() => parseUnsignedReleaseAttestation(value), 'RELEASE_ATTESTATION_STAMP_NOT_COVERED');
});

test('Shapes that are nearly right are refused, one reason each', () => {
  rejects(() => parseUnsignedReleaseAttestation({...unsigned(), schema: 'realdex.release-attestation.v2'}), 'RELEASE_ATTESTATION_SCHEMA_UNSUPPORTED');
  rejects(() => parseUnsignedReleaseAttestation({...unsigned(), extra: 1}), 'RELEASE_ATTESTATION_SHAPE_INVALID');
  rejects(() => parseUnsignedReleaseAttestation({...unsigned(), releaseId: 'Base-Sepolia'}), 'RELEASE_ATTESTATION_RELEASE_ID_INVALID');
  rejects(() => parseUnsignedReleaseAttestation({...unsigned(), bundleSha256: '0x' + 'a'.repeat(64)}), 'RELEASE_ATTESTATION_BUNDLE_INVALID');
  rejects(() => parseUnsignedReleaseAttestation({...unsigned(), builtAt: 0}), 'RELEASE_ATTESTATION_TIME_INVALID');
  rejects(() => parseUnsignedReleaseAttestation({...unsigned(), distribution: {}}), 'RELEASE_ATTESTATION_DISTRIBUTION_EMPTY');
  rejects(() => parseUnsignedReleaseAttestation({...unsigned(), sequence: 7}), 'RELEASE_ATTESTATION_SEQUENCE_INVALID');
  rejects(() => parseUnsignedReleaseAttestation({...unsigned(), sequence: '007'}), 'RELEASE_ATTESTATION_SEQUENCE_INVALID');
  rejects(() => parseUnsignedReleaseAttestation({...unsigned(), validUntil: 0}), 'RELEASE_ATTESTATION_VALIDITY_INVALID');
  rejects(() => parseUnsignedReleaseAttestation({...unsigned(), validUntil: 1756999999999}), 'RELEASE_ATTESTATION_VALIDITY_BEFORE_BUILD');
});

test('Paths that could mean two things are refused rather than normalised', () => {
  for (const path of ['../escape.js', '/absolute.js', 'assets\\windows.js', './here.js', 'a//b.js', 'with space.js']) {
    const value = unsigned();
    value.distribution[path] = hash(9);
    rejects(() => parseUnsignedReleaseAttestation(value), 'RELEASE_ATTESTATION_PATH_INVALID');
  }
});

test('A signature is checked against the address it names', async () => {
  const attestation = await sign();
  const parsed = parseReleaseAttestation(attestation);
  assert.equal(parsed.releaseId, 'base-sepolia-c052e1d9f8a4');
  assert.equal(parsed.signerAddress, getAddress(signer.address));
});

test('A signature by somebody else does not become a signature by the named address', async () => {
  const attestation = await sign();
  const forged = {...attestation, signature: await other.signMessage(releaseAttestationPayload(unsigned()))};
  rejects(() => parseReleaseAttestation(forged), 'RELEASE_ATTESTATION_SIGNATURE_MISMATCH');
});

test('Editing a hash after signing breaks the signature rather than the comparison', async () => {
  const attestation = await sign();
  const tampered = {...attestation, distribution: {...attestation.distribution, 'index.html': hash(8)}};
  rejects(() => parseReleaseAttestation(tampered), 'RELEASE_ATTESTATION_SIGNATURE_MISMATCH');
});

test('An unchecksummed signer address is refused, so two spellings cannot be one signer', async () => {
  const attestation = await sign();
  rejects(() => parseReleaseAttestation({...attestation, signerAddress: attestation.signerAddress.toLowerCase()}), 'RELEASE_ATTESTATION_SIGNER_NOT_CHECKSUMMED');
});

test('A distribution that matches passes, and says what it does not mean', async () => {
  const attestation = await sign();
  const result = verifyReleaseDistribution(attestation, observedFrom(attestation), {
    expectedSigner: signer.address, expectedReleaseId: 'base-sepolia-c052e1d9f8a4',
  });
  assert.equal(result.status, 'verified-release');
  assert.equal(result.files, 4);
  assert.equal(result.signerAddress, getAddress(signer.address));
  assert.match(result.notice, /not a review of what the bytes do/);
});

test('A changed file, a missing file and an added file are each their own answer', async () => {
  const attestation = await sign();
  const changed = observedFrom(attestation); changed['index.html'] = hash(7);
  rejects(() => verifyReleaseDistribution(attestation, changed), 'RELEASE_DISTRIBUTION_FILE_CHANGED');

  const missing = observedFrom(attestation); delete missing['assets/index-AbC0.js'];
  rejects(() => verifyReleaseDistribution(attestation, missing), 'RELEASE_DISTRIBUTION_FILE_MISSING');

  // The one that is easy to leave out: a folder someone added a file to is not the
  // folder that was signed, even though everything signed is still present and correct.
  const extra = observedFrom(attestation); extra['assets/added.js'] = hash(6);
  rejects(() => verifyReleaseDistribution(attestation, extra), 'RELEASE_DISTRIBUTION_FILE_UNEXPECTED');
});

test('A valid signature by the wrong signer, or of the wrong release, is still refused', async () => {
  const byOther = await sign(unsigned(), other);
  rejects(() => verifyReleaseDistribution(byOther, observedFrom(byOther), {expectedSigner: signer.address}), 'RELEASE_SIGNER_NOT_THE_EXPECTED_ONE');

  const older = await sign({...unsigned(), releaseId: 'base-sepolia-5885d029020b'});
  rejects(() => verifyReleaseDistribution(older, observedFrom(older), {expectedReleaseId: 'base-sepolia-c052e1d9f8a4'}), 'RELEASE_ID_NOT_THE_EXPECTED_ONE');
});

// --- what a participant decides when a newer statement arrives ---

const NOW = 1757000000000 + 86400000;
const later = (over = {}) => ({
  ...unsigned(), sequence: '8', builtAt: 1757000000000 + 1000,
  validUntil: 1757000000000 + 1000 + 90 * 86400000, ...over,
});

test('The first acceptance says outright that it proved nothing about the signer', async () => {
  const offered = await sign();
  const review = reviewReleaseUpdate({held: null, offered, now: NOW});
  assert.equal(review.status, 'first-acceptance');
  assert.equal(review.changes.added.length, 4);
  assert.deepEqual(review.changes.removed, []);
  assert.match(review.notice, /has to come from somewhere other than the download/);
});

test('A newer statement by the same signer is an update, and says which files move', async () => {
  const held = await sign();
  const next = later();
  next.distribution = {...next.distribution, 'index.html': hash(9), 'assets/added.js': hash(6)};
  delete next.distribution['assets/index-AbC0.css'];
  const review = reviewReleaseUpdate({held, offered: await sign(next), now: NOW});
  assert.equal(review.status, 'update-available');
  assert.deepEqual(review.from, {releaseId: 'base-sepolia-c052e1d9f8a4', sequence: '7'});
  assert.deepEqual(review.changes.added, ['assets/added.js']);
  assert.deepEqual(review.changes.removed, ['assets/index-AbC0.css']);
  assert.deepEqual(review.changes.changed, ['index.html']);
  assert.equal(review.releaseIdChanged, false);
});

test('Being handed the past is refused, and being handed the present is said as such', async () => {
  const held = await sign(later());
  rejects(() => reviewReleaseUpdate({held, offered: held, now: NOW}), 'RELEASE_UPDATE_ALREADY_HELD');
  // The replay that a signature alone cannot see: an older statement, genuinely signed.
  const older = await sign();
  rejects(() => reviewReleaseUpdate({held, offered: older, now: NOW}), 'RELEASE_UPDATE_NOT_NEWER');
});

test('A different key is not an update, however genuine its own signature', async () => {
  const held = await sign();
  const byOther = await sign(later(), other);
  rejects(() => reviewReleaseUpdate({held, offered: byOther, now: NOW}), 'RELEASE_UPDATE_SIGNER_CHANGED');
});

test('An expired statement cannot become the one held', async () => {
  const held = await sign();
  const offered = await sign(later());
  rejects(() => reviewReleaseUpdate({held, offered, now: offered.validUntil + 1}), 'RELEASE_UPDATE_EXPIRED');
  rejects(() => reviewReleaseUpdate({held: null, offered, now: offered.validUntil}), 'RELEASE_UPDATE_EXPIRED');
});

test('A later sequence claiming an earlier build is refused rather than guessed at', async () => {
  const held = await sign();
  const contradictory = await sign(later({builtAt: 1757000000000 - 1}));
  rejects(() => reviewReleaseUpdate({held, offered: contradictory, now: NOW}), 'RELEASE_UPDATE_BUILT_BEFORE_THE_ONE_HELD');
});

test('Sequences beyond what a double can count are still compared exactly', async () => {
  // These two are one apart, and indistinguishable once either is a JavaScript number.
  // A comparison done on numbers would call the second one already held and refuse a
  // genuine update; compared as BigInt from their decimal strings, it is newer.
  assert.equal(Number('9007199254740992') === Number('9007199254740993'), true);
  const held = await sign({...unsigned(), sequence: '9007199254740992'});
  const offered = await sign(later({sequence: '9007199254740993'}));
  assert.equal(reviewReleaseUpdate({held, offered, now: NOW}).status, 'update-available');
});

test('Freshness is reported, not enforced: an old statement does not stop the software', async () => {
  const attestation = await sign();
  const fresh = releaseAttestationFreshness(attestation, NOW);
  assert.equal(fresh.expired, false);
  assert.equal(fresh.notice, undefined);
  const stale = releaseAttestationFreshness(attestation, attestation.validUntil);
  assert.equal(stale.expired, true);
  assert.match(stale.notice, /Nothing here can tell those apart/);
  // Still verifies: being offline past a date is not the same as holding the wrong bytes.
  assert.equal(verifyReleaseDistribution(attestation, observedFrom(attestation)).status, 'verified-release');
});

test('Observations that are not hashes are refused rather than compared', async () => {
  // Reported as a broken observation, not as a changed file: the difference decides
  // whether whoever reads it goes looking for a tampered build or for their own bug.
  const attestation = await sign();
  const bad = observedFrom(attestation); bad['index.html'] = 'not-a-hash';
  rejects(() => verifyReleaseDistribution(attestation, bad), 'RELEASE_DISTRIBUTION_OBSERVATION_INVALID');
  const badPath = observedFrom(attestation); badPath['../escape.js'] = hash(2);
  rejects(() => verifyReleaseDistribution(attestation, badPath), 'RELEASE_DISTRIBUTION_OBSERVATION_INVALID');
  rejects(() => verifyReleaseDistribution(attestation, null), 'RELEASE_DISTRIBUTION_OBSERVATION_INVALID');
});
