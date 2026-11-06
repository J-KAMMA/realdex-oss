import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {need} from './guard.mjs';

function privateStat(s, {directory = false, maximum = 1048576} = {}) {
  need(directory ? s.isDirectory() : s.isFile() && s.nlink === 1 && s.size <= maximum,
    directory ? 'UNSAFE_DIRECTORY' : 'VAULT_FILE_INVALID');
  if (process.platform !== 'win32') {
    need((s.mode & 0o077) === 0 && s.uid === process.getuid(),
      directory ? 'DIRECTORY_PERMISSIONS_UNSAFE' : 'VAULT_PERMISSIONS_UNSAFE');
  }
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Single writer, crash-consistent private files. No protection against a compromised OS user. */
export class PrivateStore {
  constructor(directory) {
    need(typeof directory === 'string' && directory.length > 0, 'DIRECTORY_REQUIRED');
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    this.directoryStat = fs.lstatSync(this.directory);
    need(!this.directoryStat.isSymbolicLink(), 'UNSAFE_DIRECTORY');
    privateStat(this.directoryStat, {directory: true});
    this.file = path.join(this.directory, 'vault.json');
    this.lockFile = path.join(this.directory, 'writer.lock');
    this.lock = null;
    try {
      this.lock = fs.openSync(this.lockFile, 'wx', 0o600);
      this.lockStat = fs.fstatSync(this.lock);
      fs.writeSync(this.lock, String(process.pid));
      fs.fsyncSync(this.lock);
    } catch {
      // An initialization failure must not leak the descriptor or our own lock.
      if (this.lock !== null) {
        try {fs.closeSync(this.lock);} catch {}
        this.lock = null;
        try {if (this.lockStat && sameFile(fs.lstatSync(this.lockFile), this.lockStat)) fs.unlinkSync(this.lockFile);} catch {}
      }
      throw Error('VAULT_IN_USE_OR_STALE_LOCK');
    }
  }

  assertOwned() {
    need(this.lock !== null, 'STORE_CLOSED');
    const directory = fs.lstatSync(this.directory);
    need(!directory.isSymbolicLink() && sameFile(directory, this.directoryStat), 'STORE_DIRECTORY_CHANGED');
    privateStat(directory, {directory: true});
    let held;
    try {held = fs.lstatSync(this.lockFile);} catch {throw Error('STORE_LOCK_OWNERSHIP_LOST');}
    need(!held.isSymbolicLink() && sameFile(held, this.lockStat) && sameFile(fs.fstatSync(this.lock), this.lockStat), 'STORE_LOCK_OWNERSHIP_LOST');
    privateStat(held, {maximum: 128});
  }

  exists() {return fs.existsSync(this.file);}

  read() {
    this.assertOwned();
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {privateStat(fs.fstatSync(fd)); return fs.readFileSync(fd, 'utf8');}
    finally {fs.closeSync(fd);}
  }

  write(data, {create = false} = {}) {
    this.assertOwned();
    need(typeof data === 'string' && Buffer.byteLength(data) <= 1048576, 'VAULT_SIZE_LIMIT');
    if (create) need(!this.exists(), 'VAULT_ALREADY_EXISTS');
    if (this.exists()) {
      const s = fs.lstatSync(this.file);
      need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1, 'VAULT_FILE_INVALID');
      privateStat(s);
    }
    const temp = path.join(this.directory, '.write-' + randomBytes(16).toString('hex'));
    let fd = null;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      this.assertOwned();
      if (create) {fs.linkSync(temp, this.file); fs.unlinkSync(temp);}
      else fs.renameSync(temp, this.file);
      if (process.platform !== 'win32') {
        const d = fs.openSync(this.directory, 'r');
        try {fs.fsyncSync(d);} finally {fs.closeSync(d);}
      }
    } finally {
      // Covers write/fsync/close failures, not just rename failures.
      // Data is always ciphertext; do not silently leave unlimited partial files.
      if (fd !== null) {try {fs.closeSync(fd);} catch {}}
      try {fs.unlinkSync(temp);} catch (e) {if (e.code !== 'ENOENT') throw e;}
    }
  }

  close() {
    if (this.lock === null) return;
    const fd = this.lock; this.lock = null;
    try {fs.closeSync(fd);} finally {
      let current;
      try {current = fs.lstatSync(this.lockFile);} catch (e) {if (e.code !== 'ENOENT') throw e;}
      // Never delete a replacement writer's lock, even on a failed shutdown.
      if (current && sameFile(current, this.lockStat) && !current.isSymbolicLink()) fs.unlinkSync(this.lockFile);
    }
  }
}
