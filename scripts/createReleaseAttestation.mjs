#!/usr/bin/env node
/**
 * Writes the unsigned attestation for a built distribution.
 *
 * Reads only what is on disk and what the tree says it builds. It signs nothing and
 * loads no key: the signature is a separate step, done by whoever holds the key, on
 * their own machine.
 *
 * --sequence is the counter a participant uses to refuse being handed the past. It has to
 * increase with every attestation this signer makes, and nothing here can check that:
 * whoever signs holds the record of what they last used. --valid-days is how long the
 * statement stands before a participant should go looking for a newer one; it is not an
 * expiry on the software.
 *
 * Usage:
 *   node scripts/createReleaseAttestation.mjs --sequence <n> [--valid-days 90] [--dist dist] [--out …json]
 */
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {RELEASE_ATTESTATION_SCHEMA, RELEASE_STAMP_PATH, parseUnsignedReleaseAttestation, releaseAttestationPayload} from '../app/lib/release-attestation.mjs';
import {readDistribution} from './releaseDistribution.mjs';
import {createEvmTestnetReleasePlan} from './createEvmTestnetReleasePlan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const distDirectory = path.resolve(root, flag('--dist', 'dist'));
const outPath = path.resolve(root, flag('--out', 'artifacts-v01/release-attestation-unsigned.json'));

const distribution = await readDistribution(distDirectory);
const plan = await createEvmTestnetReleasePlan();

// The stamp inside the build has to be the release the tree says it builds, or the
// attestation would vouch for bytes belonging to some other release. This is the one
// check worth making here rather than at verification time, because at verification time
// nobody has the tree to compare against.
const stamped = distribution[RELEASE_STAMP_PATH];
if (stamped === undefined) throw new Error('RELEASE_STAMP_MISSING: ' + RELEASE_STAMP_PATH + ' is not in ' + distDirectory + '. Run the build, which stamps it.');

const sequence = flag('--sequence');
if (sequence === undefined) throw new Error('RELEASE_SEQUENCE_REQUIRED: pass --sequence <n>, one higher than the last attestation this signer made. There is no default: guessing it is how a participant ends up refusing a genuine update, or accepting an old one.');
const validDays = Number(flag('--valid-days', '90'));
if (!Number.isSafeInteger(validDays) || validDays <= 0 || validDays > 3650) throw new Error('RELEASE_VALIDITY_INVALID: --valid-days must be a whole number of days between 1 and 3650');
const builtAt = Date.now();

const attestation = parseUnsignedReleaseAttestation({
  schema: RELEASE_ATTESTATION_SCHEMA,
  releaseId: plan.releaseId,
  bundleSha256: plan.source.bundleSha256,
  sequence,
  builtAt,
  validUntil: builtAt + validDays * 86400000,
  distribution,
});

await writeFile(outPath, JSON.stringify(attestation, null, 2) + '\n', {encoding: 'utf8'});
console.log(JSON.stringify({
  wrote: path.relative(root, outPath),
  releaseId: attestation.releaseId,
  files: Object.keys(distribution).length,
  payloadSha256: 'sha256:' + (await import('node:crypto')).createHash('sha256').update(releaseAttestationPayload(attestation)).digest('hex'),
  next: 'The holder of the release key signs it: node scripts/signReleaseAttestation.mjs --in ' + path.relative(root, outPath) + ' --out <signed.json>',
}, null, 2));
