/** Test-only executable identity. No auto-download, fork, public RPC, or wallet settings change. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {need} from '../../wallet/lib/guard.mjs';
import pin from './pin.json' with {type:'json'};
export const BITCOIND_PIN = Object.freeze(pin);

export function verifiedBitcoind(input) {
  need(typeof input === 'string' && input.length > 0, 'BITCOIND_NOT_CONFIGURED');
  need(process.platform === BITCOIND_PIN.platform && process.arch === BITCOIND_PIN.arch, 'BITCOIND_PLATFORM_UNSUPPORTED');
  const file = path.resolve(input); let fd;
  try {
    const stat = fs.lstatSync(file);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === BITCOIND_PIN.bytes && (stat.mode & 0o022) === 0, 'BITCOIND_FILE_UNSAFE');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    need(opened.ino === stat.ino && opened.dev === stat.dev, 'BITCOIND_FILE_CHANGED');
    need(createHash('sha256').update(fs.readFileSync(fd)).digest('hex') === BITCOIND_PIN.sha256, 'BITCOIND_HASH_MISMATCH');
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function bitcoindStatus(input) {
  try { verifiedBitcoind(input); return {available:true, ...BITCOIND_PIN, executed:false}; }
  catch (e) { return {available:false, reason: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'BITCOIND_UNAVAILABLE', executed:false}; }
}
