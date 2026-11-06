/** Test-only executable identity. No auto-download, fork, public RPC, or wallet settings change. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {need} from '../../wallet/lib/guard.mjs';
import pin from './pin.json' with {type:'json'};
export const ANVIL_PIN = Object.freeze(pin);

export function verifiedAnvil(input) {
  need(typeof input === 'string' && input.length > 0, 'ANVIL_NOT_CONFIGURED');
  need(process.platform === ANVIL_PIN.platform && process.arch === ANVIL_PIN.arch, 'ANVIL_PLATFORM_UNSUPPORTED');
  const file = path.resolve(input); let fd;
  try {
    const stat = fs.lstatSync(file);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === ANVIL_PIN.bytes && (stat.mode & 0o022) === 0, 'ANVIL_FILE_UNSAFE');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    need(opened.ino === stat.ino && opened.dev === stat.dev, 'ANVIL_FILE_CHANGED');
    need(createHash('sha256').update(fs.readFileSync(fd)).digest('hex') === ANVIL_PIN.sha256, 'ANVIL_HASH_MISMATCH');
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function anvilStatus(input) {
  try { verifiedAnvil(input); return {available:true, ...ANVIL_PIN, executed:false}; }
  catch (e) { return {available:false, reason: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'ANVIL_UNAVAILABLE', executed:false}; }
}
