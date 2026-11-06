import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createIdentity, createAnnouncement } from '../lib/protocol.mjs';
import { Catalogue, HeadStore, atomicJson, readJsonFile, acquireInstanceLock } from '../lib/store.mjs';
import { NOW, factory, directory } from './fixtures.mjs';
const identity = createIdentity();
const entry = (revision = 1, factories = [factory()], now = NOW) => createAnnouncement(identity, revision, factories, now);

test('factory signatures yield candidates, never executable routes', () => {
  const c = new Catalogue([identity.publicKey]); c.accept(entry(), NOW);
  assert.equal(c.candidates(NOW)[0].executable, false); assert.equal(c.candidates(NOW)[0].verification, 'unverified-candidate');
});
test('a cryptographic signature from an unpinned key is insufficient', () => {
  const c = new Catalogue([createIdentity().publicKey]); assert.throws(() => c.accept(entry(), NOW), /NOT_PINNED/); assert.deepEqual(c.candidates(NOW), []);
});
test('revision rollback and same-revision content changes reject', () => {
  const c = new Catalogue([identity.publicKey]); c.accept(entry(2), NOW);
  assert.throws(() => c.accept(entry(1), NOW), /ROLLBACK/);
  assert.throws(() => c.accept(entry(2, [factory('2')]), NOW), /EQUIVOCATION/);
  assert.equal(c.candidates(NOW)[0].address, factory().address);
});
test('fresh heartbeat may retain revision only if the catalogue content stays identical', () => {
  const c = new Catalogue([identity.publicKey]); c.accept(entry(), NOW); c.accept(entry(1, [factory()], NOW + 1), NOW + 1);
  assert.equal(c.export(NOW + 1)[0].payload.issuedAt, NOW + 1);
  assert.equal(c.accept(entry(), NOW + 1), 'unchanged');
});
test('new empty catalogue revokes this publisher entire previous candidate set', () => {
  const c = new Catalogue([identity.publicKey]); c.accept(entry(), NOW); c.accept(entry(2, []), NOW);
  assert.deepEqual(c.candidates(NOW), []); assert.throws(() => c.accept(entry(), NOW), /ROLLBACK/);
});
test('expired candidate disappears while rollback head survives', () => {
  const c = new Catalogue([identity.publicKey]); c.accept(entry(2), NOW);
  assert.deepEqual(c.candidates(NOW + 300000), []);
  assert.throws(() => c.accept(entry(1, [factory()], NOW + 300000), NOW + 300000), /ROLLBACK/);
});
test('moving the clock backwards fails closed', () => {
  const c = new Catalogue([identity.publicKey]); c.accept(entry(), NOW);
  assert.throws(() => c.export(NOW - 1), /CLOCK_MOVED_BACKWARDS/);
});
test('callers cannot mutate cached signatures or manufacture execution through a returned object', () => {
  const c = new Catalogue([identity.publicKey]); const original = entry(); c.accept(original, NOW);
  original.payload.factories = []; const exported = c.export(NOW); exported[0].payload.factories = [];
  const candidates = c.candidates(NOW); candidates[0].executable = true;
  assert.equal(c.candidates(NOW).length, 1); assert.equal(c.candidates(NOW)[0].executable, false);
});
test('persistent heads reject replay after node restart', t => {
  const file = path.join(directory(t), 'heads.json'); let c = new Catalogue([identity.publicKey], new HeadStore(file)); c.accept(entry(2), NOW);
  c = new Catalogue([identity.publicKey], new HeadStore(file)); assert.throws(() => c.accept(entry(1), NOW), /ROLLBACK/);
  assert.throws(() => c.accept(entry(2, [factory('2')]), NOW), /EQUIVOCATION/);
  c.accept(entry(2), NOW); assert.equal(c.candidates(NOW).length, 1);
});
test('corrupt durable heads stop startup rather than reset anti-replay protection', t => {
  const file = path.join(directory(t), 'heads.json'); fs.writeFileSync(file, '{}'); assert.throws(() => new HeadStore(file), /HEAD_STORE_INVALID/);
});
test('failure to durably write a new head does not admit the candidate', t => {
  const dir = directory(t); const file = path.join(dir, 'blocked'); fs.mkdirSync(file);
  const store = new HeadStore(); store.file = file; const c = new Catalogue([identity.publicKey], store);
  assert.throws(() => c.accept(entry(), NOW)); assert.deepEqual(c.candidates(NOW), []); assert.deepEqual(store.heads, {});
});
test('atomic JSON does not leave temporary files and uses restrictive Unix mode', t => {
  const dir = directory(t); const file = path.join(dir, 'test.json'); atomicJson(file, { x: 1 }); atomicJson(file, { x: 2 });
  assert.deepEqual(readJsonFile(file), { x: 2 }); assert.deepEqual(fs.readdirSync(dir), ['test.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test('local identity/head inputs reject symlinks', t => {
  const dir = directory(t); atomicJson(path.join(dir, 'real.json'), {}); fs.symlinkSync('real.json', path.join(dir, 'link.json'));
  assert.throws(() => readJsonFile(path.join(dir, 'link.json')), /LOCAL_FILE_INVALID/);
});
test('exclusive instance lock prevents concurrent writers and is explicitly released', t => {
  const dir = directory(t); const release = acquireInstanceLock(dir);
  assert.throws(() => acquireInstanceLock(dir), /INSTANCE_LOCKED/); release(); release(); const next = acquireInstanceLock(dir); next();
});
