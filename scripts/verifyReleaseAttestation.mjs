#!/usr/bin/env node
/**
 * What a participant runs on the folder they were given.
 *
 * It needs nothing from this repository except this script: no network, no key, no
 * profile, no trust in the download. It hashes what is there, checks the signature over
 * those hashes, and checks the signer is the address the participant was told.
 *
 * Passing the expected signer is the point of the whole exercise. Without --signer this
 * only says the folder matches a statement that came with it, which whoever changed the
 * folder could also have written. It says so in the result rather than passing quietly.
 *
 * Usage:
 *   node scripts/verifyReleaseAttestation.mjs --dist <folder> --attestation <signed.json> [--signer 0x…] [--release base-sepolia-…]
 * Exits non-zero and names the reason on any mismatch.
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyReleaseDistribution} from '../app/lib/release-attestation.mjs';
import {readDistribution} from './releaseDistribution.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const distDirectory = flag('--dist');
const attestationPath = flag('--attestation');
if (!distDirectory || !attestationPath) throw new Error('Usage: --dist <folder> --attestation <signed.json> [--signer 0x…] [--release base-sepolia-…]');

const attestation = JSON.parse(await readFile(path.resolve(root, attestationPath), 'utf8'));
const observed = await readDistribution(path.resolve(root, distDirectory));
const result = verifyReleaseDistribution(attestation, observed, {expectedSigner: flag('--signer'), expectedReleaseId: flag('--release')});

console.log(JSON.stringify({
  ...result,
  signerWasChecked: flag('--signer') !== undefined,
  ...(flag('--signer') === undefined ? {
    warning: 'No --signer was given, so this only says the folder matches the statement that came with it. Anyone who changed the folder could have written that statement too. Ask for the address separately and pass it.',
  } : {}),
}, null, 2));
