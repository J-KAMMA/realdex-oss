import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { LIMITS, catalogueFingerprint, exact, integer, need, publicKeyValid, verifyAnnouncement } from './protocol.mjs';

export function readJsonFile(file, maximumBytes = LIMITS.bytes) {
  const stat = fs.lstatSync(file);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximumBytes, 'LOCAL_FILE_INVALID');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function atomicJson(file, value) {
  const dir = path.dirname(file); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  need(!fs.lstatSync(dir).isSymbolicLink(), 'DATA_DIRECTORY_SYMLINK');
  const temp = path.join(dir, '.' + path.basename(file) + '.' + randomBytes(8).toString('hex') + '.tmp');
  let descriptor;
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temp, file);
    // Directory syncing is supported on Unix; Windows may reject opening a directory.
    if (process.platform !== 'win32') { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export function acquireInstanceLock(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'instance.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error('INSTANCE_LOCKED_CHECK_OTHER_PROCESS_BEFORE_REMOVING_LOCK'); }
  fs.writeFileSync(path.join(lock, 'process.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx', mode: 0o600 });
  let released = false;
  return () => { if (!released) { released = true; fs.rmSync(lock, { recursive: true }); } };
}
export class HeadStore {
  constructor(file = null) {
    this.file = file; this.heads = {};
    if (file && fs.existsSync(file)) {
      const data = readJsonFile(file); exact(data, ['schema', 'heads'], 'HEAD_STORE_INVALID');
      need(data.schema === 'realdex.node.heads.v1' && data.heads && Object.getPrototypeOf(data.heads) === Object.prototype &&
        Object.keys(data.heads).length <= LIMITS.publishers, 'HEAD_STORE_INVALID');
      for (const [key, head] of Object.entries(data.heads)) {
        need(publicKeyValid(key), 'HEAD_STORE_INVALID'); exact(head, ['revision', 'fingerprint'], 'HEAD_STORE_INVALID');
        integer(head.revision, 1, Number.MAX_SAFE_INTEGER, 'HEAD_STORE_INVALID');
        need(typeof head.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(head.fingerprint), 'HEAD_STORE_INVALID');
      }
      this.heads = data.heads;
    }
  }
  admit(payload) {
    const fingerprint = catalogueFingerprint(payload); const head = this.heads[payload.publisher];
    if (head) {
      need(payload.revision >= head.revision, 'CATALOGUE_ROLLBACK');
      need(payload.revision !== head.revision || head.fingerprint === fingerprint, 'CATALOGUE_EQUIVOCATION');
      if (payload.revision === head.revision) return;
    }
    need(head || Object.keys(this.heads).length < LIMITS.publishers, 'HEAD_STORE_FULL');
    const next = { ...this.heads, [payload.publisher]: { revision: payload.revision, fingerprint } };
    if (this.file) atomicJson(this.file, { schema: 'realdex.node.heads.v1', heads: next });
    this.heads = next;
  }
}
export class Catalogue {
  constructor(publishers, headStore = new HeadStore()) {
    need(Array.isArray(publishers) && publishers.length <= LIMITS.publishers && publishers.every(publicKeyValid) &&
      new Set(publishers).size === publishers.length, 'PUBLISHER_POLICY_INVALID');
    this.publishers = new Set(publishers); this.headStore = headStore; this.entries = new Map(); this.lastNow = 0;
  }
  time(now) {
    integer(now, 1, Number.MAX_SAFE_INTEGER, 'CLOCK_INVALID');
    need(now >= this.lastNow, 'CLOCK_MOVED_BACKWARDS'); this.lastNow = now;
  }
  accept(envelope, now = Date.now()) {
    this.time(now);
    // No arbitrary peer key can add to the local discovery policy. A pin identifies a
    // publisher, not the truth of its claims and never permission to spend funds.
    need(this.publishers.has(envelope?.payload?.publisher), 'PUBLISHER_NOT_PINNED');
    const p = verifyAnnouncement(envelope, now); this.headStore.admit(p);
    const current = this.entries.get(p.publisher);
    if (current && p.revision === current.payload.revision && p.issuedAt <= current.payload.issuedAt) return 'unchanged';
    this.entries.set(p.publisher, structuredClone(envelope)); return 'accepted';
  }
  export(now = Date.now()) {
    this.time(now);
    for (const [key, entry] of this.entries) if (entry.payload.expiresAt <= now) this.entries.delete(key);
    return [...this.entries.values()].sort((a, b) => a.payload.publisher < b.payload.publisher ? -1 : 1).map(x => structuredClone(x));
  }
  candidates(now = Date.now()) {
    const result = new Map();
    for (const envelope of this.export(now)) {
      const p = envelope.payload;
      for (const factory of p.factories) {
        const key = factory.chainId + '/' + factory.address;
        const record = result.get(key) ?? { ...factory, verification: 'unverified-candidate', executable: false, sources: [] };
        record.sources.push({ publisher: p.publisher, revision: p.revision, expiresAt: p.expiresAt }); result.set(key, record);
      }
    }
    return [...result.values()].sort((a, b) => (a.chainId + a.address).localeCompare(b.chainId + b.address));
  }
}
