#!/usr/bin/env node
/**
 * Signs a release attestation. The owner runs this; I do not.
 *
 * The key is read from a file whose path is given in REALDEX_RELEASE_KEY_FILE, in the
 * same shape the deployment signer uses: {"privateKey": "0x…"}. Not an environment
 * variable holding the key itself — that goes to every child process and lands in shell
 * history. See the internal design notes (not published), which also says to create that file from the
 * operating system's own store and delete it afterwards.
 *
 * The key is never printed, never logged, and never passed as an argument. What this
 * prints is the address, which is public and is the thing participants pin.
 *
 * Usage:
 *   REALDEX_RELEASE_KEY_FILE=… node scripts/signReleaseAttestation.mjs --in <unsigned.json> --out <signed.json>
 */
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Wallet, getAddress} from 'ethers';
import {parseUnsignedReleaseAttestation, parseReleaseAttestation, releaseAttestationPayload} from '../app/lib/release-attestation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const inPath = flag('--in');
const outPath = flag('--out');
if (!inPath || !outPath) throw new Error('Usage: --in <unsigned.json> --out <signed.json>');

const keyFile = process.env.REALDEX_RELEASE_KEY_FILE;
if (!keyFile) throw new Error('REALDEX_RELEASE_KEY_FILE is required. It names a file holding {"privateKey": "0x…"}; the key itself must not be an environment variable.');

const unsigned = parseUnsignedReleaseAttestation(JSON.parse(await readFile(path.resolve(root, inPath), 'utf8')));
const keyMaterial = JSON.parse(await readFile(keyFile, 'utf8'));
if (typeof keyMaterial?.privateKey !== 'string') throw new Error('RELEASE_KEY_FILE_SHAPE_INVALID: expected {"privateKey": "0x…"}');

const wallet = new Wallet(keyMaterial.privateKey);
const signature = await wallet.signMessage(releaseAttestationPayload(unsigned));
const signed = {...unsigned, signerAddress: getAddress(wallet.address), signature};

// Verified here before it is written. An attestation that does not verify is worse than
// none: it looks like evidence until somebody checks it.
parseReleaseAttestation(signed);
await writeFile(path.resolve(root, outPath), JSON.stringify(signed, null, 2) + '\n', {encoding: 'utf8', flag: 'wx'});
console.log(JSON.stringify({
  wrote: outPath,
  releaseId: signed.releaseId,
  files: Object.keys(signed.distribution).length,
  signerAddress: signed.signerAddress,
  tellParticipants: 'the signer address above, through a channel that is not the download itself',
}, null, 2));
