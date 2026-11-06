#!/usr/bin/env node
/**
 * What a participant runs when a newer attestation reaches them.
 *
 * It compares the offered statement against the one they already hold, and prints what
 * would change. It moves nothing and installs nothing: deciding to take an update is a
 * person's decision, and this exists so that decision is made in front of a list of the
 * files that move rather than a version number.
 *
 * Without --held this is a first acceptance, which is the one case where nothing here
 * says anything about the signer being the right one.
 *
 * Usage:
 *   node scripts/reviewReleaseUpdate.mjs [--held <held.json>] --offered <offered.json>
 * Exits non-zero and names the reason when the offered statement must not be taken.
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reviewReleaseUpdate, releaseAttestationFreshness} from '../app/lib/release-attestation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const offeredPath = flag('--offered');
const heldPath = flag('--held');
if (!offeredPath) throw new Error('Usage: [--held <held.json>] --offered <offered.json>');

const read = async p => JSON.parse(await readFile(path.resolve(root, p), 'utf8'));
const offered = await read(offeredPath);
const held = heldPath ? await read(heldPath) : null;
const now = Date.now();

const review = reviewReleaseUpdate({held, offered, now});
console.log(JSON.stringify({
  ...review,
  ...(held ? {heldFreshness: releaseAttestationFreshness(held, now)} : {}),
  reminder: 'Nothing was installed. Verify the folder you were given against the offered statement before using it: scripts/verifyReleaseAttestation.mjs',
}, null, 2));
