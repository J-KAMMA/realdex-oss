/**
 * A signed statement binding a release identity to the exact bytes of its distribution.
 *
 * The clean-room reproduction proves that this source builds these bytes. The profile
 * proves which deployment the build talks to. Neither helps a participant who has been
 * handed a folder: they can compute hashes, but they have nothing to compare them
 * against except a file that arrived alongside the folder and could have been written by
 * whoever changed it. This closes that: the hashes are signed, and the participant checks
 * the signature against an address they were told separately.
 *
 * What it does not do. It says the signer vouched for these bytes; it does not say the
 * bytes are safe, that the signer is trustworthy, or that the address the participant
 * pinned is the right one. A signature over a distribution nobody reviewed is a signature
 * over a distribution nobody reviewed.
 *
 * Pure. No file system, no network, no key. The scripts do the reading and the signing;
 * everything that decides anything is here, where the tests can reach it.
 */
import {verifyMessage, getAddress} from 'ethers';

export const RELEASE_ATTESTATION_SCHEMA = 'realdex.release-attestation.v1';

/** Stamped into the distribution by scripts/stampReleaseId.mjs. An attestation that does
 *  not cover it cannot say which release the participant is holding, which is the one
 *  thing it exists to say. */
export const RELEASE_STAMP_PATH = 'release-id.txt';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SEQUENCE = /^(?:0|[1-9][0-9]{0,18})$/;
const RELEASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+){1,4}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
// Deliberately narrow: a distribution path is something a build wrote, not a path a
// participant types. Anything with a drive letter, a backslash, a leading slash or a dot
// segment is refused rather than normalised, because normalising is how two different
// paths become one.
//
// The lookahead rejects a segment that is exactly "." or "..". Without it the character
// class alone accepted both, since a dot is a legal character in a file name — the first
// version of this did, and the test written for it is what said so. A name that merely
// starts with dots, like "..config", is still a name and stays allowed.
const DIST_PATH = /^(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)*$/;

const need = (ok, code) => { if (!ok) throw new Error(code); };
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function exactKeys(value, keys, code) {
  need(isRecord(value), code);
  need(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), code);
  return value;
}

/**
 * The bytes that get signed.
 *
 * Counted and sorted, so the same set of files always produces the same string and a
 * reordered or truncated list is a different one. Paths and hashes are validated before
 * they reach here, so neither can contain a newline and split a line in two.
 */
export function releaseAttestationPayload(attestation) {
  const {releaseId, bundleSha256, sequence, builtAt, validUntil, distribution} = attestation;
  const entries = Object.entries(distribution).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    'RealDEX release attestation v1',
    releaseId,
    bundleSha256,
    sequence,
    String(builtAt),
    String(validUntil),
    String(entries.length),
    ...entries.map(([path, hash]) => path + ' ' + hash),
  ].join('\n') + '\n';
}

/** Everything except the signature: what the create step writes and the sign step reads. */
export function parseUnsignedReleaseAttestation(input) {
  const value = exactKeys(input, ['schema', 'releaseId', 'bundleSha256', 'sequence', 'builtAt', 'validUntil', 'distribution'], 'RELEASE_ATTESTATION_SHAPE_INVALID');
  need(value.schema === RELEASE_ATTESTATION_SCHEMA, 'RELEASE_ATTESTATION_SCHEMA_UNSUPPORTED');
  need(typeof value.releaseId === 'string' && RELEASE_ID.test(value.releaseId), 'RELEASE_ATTESTATION_RELEASE_ID_INVALID');
  need(typeof value.bundleSha256 === 'string' && SHA256.test(value.bundleSha256), 'RELEASE_ATTESTATION_BUNDLE_INVALID');
  // A counter the signer increments, not a clock. A wall clock is what the signer's
  // machine happened to say, and two builds can share a millisecond; deciding "is this
  // newer than what I hold" on that is deciding it on somebody's system settings. Kept as
  // a decimal string so a release beyond 2^53 is still exactly the number it says.
  need(typeof value.sequence === 'string' && SEQUENCE.test(value.sequence), 'RELEASE_ATTESTATION_SEQUENCE_INVALID');
  // Not an expiry on the software: a folder does not stop working. It is how a
  // participant notices they have been left on an old version by someone who simply
  // stopped delivering new ones. Withholding is the attack that a signature cannot see.
  need(Number.isSafeInteger(value.validUntil) && value.validUntil > 0, 'RELEASE_ATTESTATION_VALIDITY_INVALID');
  need(value.validUntil > value.builtAt, 'RELEASE_ATTESTATION_VALIDITY_BEFORE_BUILD');
  need(Number.isSafeInteger(value.builtAt) && value.builtAt > 0, 'RELEASE_ATTESTATION_TIME_INVALID');
  need(isRecord(value.distribution), 'RELEASE_ATTESTATION_DISTRIBUTION_INVALID');
  const paths = Object.keys(value.distribution);
  need(paths.length > 0, 'RELEASE_ATTESTATION_DISTRIBUTION_EMPTY');
  for (const path of paths) {
    need(DIST_PATH.test(path), 'RELEASE_ATTESTATION_PATH_INVALID');
    need(typeof value.distribution[path] === 'string' && SHA256.test(value.distribution[path]), 'RELEASE_ATTESTATION_HASH_INVALID');
  }
  need(Object.hasOwn(value.distribution, RELEASE_STAMP_PATH), 'RELEASE_ATTESTATION_STAMP_NOT_COVERED');
  return value;
}

/** The signed form. The signature is checked here, against the address it claims. */
export function parseReleaseAttestation(input) {
  need(isRecord(input), 'RELEASE_ATTESTATION_SHAPE_INVALID');
  const {signature, signerAddress, ...rest} = input;
  const unsigned = parseUnsignedReleaseAttestation(rest);
  need(typeof signerAddress === 'string' && ADDRESS.test(signerAddress), 'RELEASE_ATTESTATION_SIGNER_INVALID');
  need(getAddress(signerAddress) === signerAddress, 'RELEASE_ATTESTATION_SIGNER_NOT_CHECKSUMMED');
  need(typeof signature === 'string' && SIGNATURE.test(signature), 'RELEASE_ATTESTATION_SIGNATURE_INVALID');
  let recovered;
  try { recovered = verifyMessage(releaseAttestationPayload(unsigned), signature); }
  catch { throw new Error('RELEASE_ATTESTATION_SIGNATURE_UNRECOVERABLE'); }
  need(recovered === signerAddress, 'RELEASE_ATTESTATION_SIGNATURE_MISMATCH');
  return {...unsigned, signerAddress, signature};
}

/**
 * What a participant actually asks: are the files I have the files this vouches for, and
 * did the person I expected vouch for them?
 *
 * `observed` is path -> "sha256:…" for every file found, and the comparison is exact in
 * both directions. A missing file is obvious; an extra one matters just as much, because
 * a folder someone added a file to is not the folder that was signed.
 */
export function verifyReleaseDistribution(attestation, observed, {expectedSigner, expectedReleaseId} = {}) {
  const parsed = parseReleaseAttestation(attestation);
  need(isRecord(observed), 'RELEASE_DISTRIBUTION_OBSERVATION_INVALID');

  if (expectedSigner !== undefined) {
    need(typeof expectedSigner === 'string' && ADDRESS.test(expectedSigner), 'RELEASE_EXPECTED_SIGNER_INVALID');
    need(getAddress(expectedSigner) === parsed.signerAddress, 'RELEASE_SIGNER_NOT_THE_EXPECTED_ONE');
  }
  if (expectedReleaseId !== undefined) {
    need(parsed.releaseId === expectedReleaseId, 'RELEASE_ID_NOT_THE_EXPECTED_ONE');
  }

  // Establish that every observation is a hash before comparing any of them. Comparing
  // first meant a malformed observation could be reported as a changed file, which sends
  // whoever reads it looking for a tampered build instead of a broken caller.
  for (const [path, value] of Object.entries(observed)) {
    need(DIST_PATH.test(path), 'RELEASE_DISTRIBUTION_OBSERVATION_INVALID');
    need(typeof value === 'string' && SHA256.test(value), 'RELEASE_DISTRIBUTION_OBSERVATION_INVALID');
  }

  const attested = Object.keys(parsed.distribution).sort();
  const found = Object.keys(observed).sort();
  const missing = attested.filter(p => !Object.hasOwn(observed, p));
  const unexpected = found.filter(p => !Object.hasOwn(parsed.distribution, p));
  need(missing.length === 0, 'RELEASE_DISTRIBUTION_FILE_MISSING');
  need(unexpected.length === 0, 'RELEASE_DISTRIBUTION_FILE_UNEXPECTED');
  need(attested.every(p => observed[p] === parsed.distribution[p]), 'RELEASE_DISTRIBUTION_FILE_CHANGED');

  return {
    status: 'verified-release',
    releaseId: parsed.releaseId,
    bundleSha256: parsed.bundleSha256,
    sequence: parsed.sequence,
    signerAddress: parsed.signerAddress,
    files: attested.length,
    // Said plainly, because a green result is where someone stops reading.
    notice: 'The signer vouched for these exact bytes. That is not a review of what the bytes do, and not a statement that this signer should be trusted.',
  };
}

/**
 * What a participant decides when a newer attestation arrives.
 *
 * A signature says who wrote a statement. It does not say the statement is the latest
 * one, and it does not stop somebody replaying an older genuine statement to put a
 * participant back on a version whose defects are known. So the decision needs the one
 * they already hold, and three things have to be true of the offered one:
 *
 *   - the same signer. A different key is not an update, whatever it says about itself.
 *     Changing signer is a decision a participant makes deliberately, out of band, not
 *     something an update stream does to them.
 *   - a higher sequence. Equal means they already have it, lower means somebody is
 *     handing them the past.
 *   - still within its own validity. An expired statement is the signal that the stream
 *     has stopped, and accepting it as current would hide exactly that.
 *
 * `held` is null the first time, which is the one case with nothing to compare against —
 * and so the one case where the participant has to check the signer address themselves.
 * It returns what changes rather than a yes: an update review that does not say which
 * files move is not a review.
 */
export function reviewReleaseUpdate({held, offered, now}) {
  need(Number.isSafeInteger(now) && now > 0, 'RELEASE_UPDATE_TIME_INVALID');
  const next = parseReleaseAttestation(offered);
  need(next.validUntil > now, 'RELEASE_UPDATE_EXPIRED');

  if (held === null || held === undefined) {
    return {
      status: 'first-acceptance',
      releaseId: next.releaseId, sequence: next.sequence, signerAddress: next.signerAddress,
      changes: {added: Object.keys(next.distribution).sort(), removed: [], changed: []},
      notice: 'Nothing was held to compare against, so nothing here says this signer is the right one. That has to come from somewhere other than the download.',
    };
  }

  const current = parseReleaseAttestation(held);
  need(current.signerAddress === next.signerAddress, 'RELEASE_UPDATE_SIGNER_CHANGED');
  const a = BigInt(current.sequence), b = BigInt(next.sequence);
  need(b !== a, 'RELEASE_UPDATE_ALREADY_HELD');
  need(b > a, 'RELEASE_UPDATE_NOT_NEWER');
  // A later sequence claiming an earlier build time means the two statements disagree
  // about their own order. Refusing is not paranoia about clocks; it is refusing to
  // guess which of the signer's two claims to believe.
  need(next.builtAt >= current.builtAt, 'RELEASE_UPDATE_BUILT_BEFORE_THE_ONE_HELD');

  const before = current.distribution, after = next.distribution;
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return {
    status: 'update-available',
    from: {releaseId: current.releaseId, sequence: current.sequence},
    releaseId: next.releaseId, sequence: next.sequence, signerAddress: next.signerAddress,
    releaseIdChanged: current.releaseId !== next.releaseId,
    changes: {
      added: paths.filter(p => !Object.hasOwn(before, p)),
      removed: paths.filter(p => !Object.hasOwn(after, p)),
      changed: paths.filter(p => Object.hasOwn(before, p) && Object.hasOwn(after, p) && before[p] !== after[p]),
    },
    notice: 'Newer, by the same signer, and not expired. Whether the change is one to want is not something a signature can answer.',
  };
}

/**
 * Whether the statement a participant holds has outlived its own validity.
 *
 * Separate from verification on purpose. An expired attestation does not make the folder
 * stop working, and refusing to run would punish somebody who is merely offline. It means
 * they should go and look for a newer one, and that nobody can tell them from here
 * whether one exists.
 */
export function releaseAttestationFreshness(attestation, now) {
  need(Number.isSafeInteger(now) && now > 0, 'RELEASE_UPDATE_TIME_INVALID');
  const parsed = parseReleaseAttestation(attestation);
  const expired = now >= parsed.validUntil;
  return {
    releaseId: parsed.releaseId, sequence: parsed.sequence, validUntil: parsed.validUntil, expired,
    ...(expired ? {notice: 'This statement is past the date its signer set. Either no newer one has been made, or one exists and has not reached you. Nothing here can tell those apart.'} : {}),
  };
}
