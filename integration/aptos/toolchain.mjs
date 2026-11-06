/** Test-only executable identity. No auto-download, fork, public RPC, or wallet settings change. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {need} from '../../wallet/lib/guard.mjs';
import pin from './pin.json' with {type:'json'};
export const APTOS_PIN = Object.freeze(pin);

export function verifiedAptos(input) {
  need(typeof input === 'string' && input.length > 0, 'APTOS_NOT_CONFIGURED');
  need(process.platform === APTOS_PIN.platform && process.arch === APTOS_PIN.arch, 'APTOS_PLATFORM_UNSUPPORTED');
  const file = path.resolve(input); let fd;
  try {
    const stat = fs.lstatSync(file);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === APTOS_PIN.bytes && (stat.mode & 0o022) === 0, 'APTOS_FILE_UNSAFE');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    need(opened.ino === stat.ino && opened.dev === stat.dev, 'APTOS_FILE_CHANGED');
    need(createHash('sha256').update(fs.readFileSync(fd)).digest('hex') === APTOS_PIN.sha256, 'APTOS_HASH_MISMATCH');
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function aptosStatus(input) {
  try { verifiedAptos(input); return {available:true, ...APTOS_PIN, executed:false}; }
  catch (e) { return {available:false, reason: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'APTOS_UNAVAILABLE', executed:false}; }
}
