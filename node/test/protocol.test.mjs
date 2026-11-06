import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, assertIdentity, signPayload, createAnnouncement, verifyAnnouncement, createSnapshot, verifySnapshot, canonical, nodeId, LIMITS } from '../lib/protocol.mjs';
import { peerUrl, validateConfig } from '../lib/config.mjs';
import { NOW, factory, config } from './fixtures.mjs';
const identity = createIdentity();
const announcement = () => createAnnouncement(identity, 1, [factory()], NOW);

test('node identity round-trips and is domain-labelled, not an EVM wallet', () => {
  assert.equal(assertIdentity(identity).asymmetricKeyType, 'ed25519');
  assert.match(nodeId(identity.publicKey), /^realdex-node:[0-9a-f]{64}$/);
  assert.throws(() => assertIdentity({ ...identity, publicKey: createIdentity().publicKey }), /KEY_MISMATCH/);
});
test('authentic announcement survives JSON transport and key reordering', () => {
  const a = JSON.parse(JSON.stringify(announcement()));
  a.payload.factories[0] = { protocol: 'realdex-cpmm-v1', address: factory().address, chainId: factory().chainId };
  assert.equal(verifyAnnouncement(a, NOW).factories.length, 1);
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
});
test('modified factory, revision, or signature is rejected', () => {
  for (const mutate of [x => { x.payload.factories[0].address = factory('2').address; }, x => { x.payload.revision++; }, x => { x.signature = '0'.repeat(128); }]) {
    const a = announcement(); mutate(a); assert.throws(() => verifyAnnouncement(a, NOW), /SIGNATURE_INVALID/);
  }
});
test('unknown fields cannot smuggle an RPC endpoint or execution flag', () => {
  for (const mutate of [x => { x.payload.rpc = 'https://example.invalid'; }, x => { x.payload.factories[0].executable = true; }, x => { x.command = 'send'; }]) {
    const a = announcement(); mutate(a); assert.throws(() => verifyAnnouncement(a, NOW));
  }
});
for (const [label, issuedAt, expiresAt] of [
  ['expired', NOW - 1000, NOW], ['future', NOW + 2001, NOW + 5000], ['too long lived', NOW, NOW + LIMITS.announcementTtlMs + 1], ['zero lifetime', NOW, NOW]
]) test('rejects ' + label + ' announcement even with valid signature', () => {
  const p = { ...announcement().payload, issuedAt, expiresAt };
  assert.throws(() => verifyAnnouncement(signPayload(p, identity), NOW), /MESSAGE_EXPIRED_OR_FUTURE/);
});
test('factory identities reject zero, uppercase EVM address, unknown chain and duplicates', () => {
  for (const candidate of [factory('0'), { ...factory(), address: '0x' + 'A'.repeat(40) }, { ...factory(), chainId: 'solana:devnet' }, { ...factory(), protocol: 'auto-execute' }]) {
    assert.throws(() => createAnnouncement(identity, 1, [candidate], NOW));
  }
  assert.throws(() => createAnnouncement(identity, 1, [factory(), factory()], NOW), /DUPLICATE/);
});
test('factory order is deterministic and resource limits apply', () => {
  const a = createAnnouncement(identity, 1, [factory('2'), factory()], NOW);
  assert.equal(a.payload.factories[0].address, factory().address);
  assert.throws(() => createAnnouncement(identity, 1, Array(17).fill(factory()), NOW), /FACTORIES_LIMIT/);
  assert.throws(() => createAnnouncement(identity, 0, [], NOW), /REVISION_INVALID/);
});
test('snapshot binds exact peer and fresh request challenge', () => {
  const nonce = 'f'.repeat(64); const s = createSnapshot(identity, nonce, [announcement()], NOW);
  assert.equal(verifySnapshot(s, identity.publicKey, nonce, NOW).announcements.length, 1);
  assert.throws(() => verifySnapshot(s, identity.publicKey, 'e'.repeat(64), NOW), /CHALLENGE/);
  assert.throws(() => verifySnapshot(s, createIdentity().publicKey, nonce, NOW), /CHALLENGE/);
  assert.throws(() => verifySnapshot(s, identity.publicKey, nonce, NOW + 15000), /EXPIRED/);
});
test('snapshot signature covers all relayed origin announcements', () => {
  const nonce = 'f'.repeat(64); const s = createSnapshot(identity, nonce, [announcement()], NOW);
  s.payload.announcements[0].payload.factories = [];
  assert.throws(() => verifySnapshot(s, identity.publicKey, nonce, NOW), /SIGNATURE/);
});
test('transport accepts explicit HTTPS origins and numeric-loopback HTTP only', () => {
  assert.equal(peerUrl('https://peer.example/'), 'https://peer.example');
  assert.equal(peerUrl('http://127.0.0.1:1234/'), 'http://127.0.0.1:1234');
  assert.equal(peerUrl('http://[::1]:1234/'), 'http://[::1]:1234');
  for (const url of ['http://peer.example', 'http://localhost:1234', 'file:///etc/passwd', 'https://a:b@peer.example',
    'https://peer.example/path', 'https://peer.example/?rpc=x', 'https://peer.example/#x', 'http://192.168.1.2:1234']) {
    assert.throws(() => peerUrl(url), /PEER_URL_INVALID/);
  }
});
test('config defaults are local and peer/publication policy is bounded', () => {
  const c = validateConfig(config(), '/tmp/node/config.json'); assert.equal(c.dataDir, '/tmp/node'); assert.equal(c.serveDex, false);
  assert.throws(() => validateConfig({ ...config(), walletKey: 'never' }, '/tmp/c'), /CONFIG_INVALID/);
  assert.throws(() => validateConfig(config({ peers: [{ url: 'https://peer.example', publicKey: identity.publicKey }, { url: 'https://peer.example', publicKey: identity.publicKey }] }), '/tmp/c'), /DUPLICATE/);
  assert.throws(() => validateConfig(config({ syncIntervalMs: 0 }), '/tmp/c'), /INTERVAL/);
  assert.throws(() => validateConfig(config({ allowedHosts: ['*'] }), '/tmp/c'), /HOSTS/);
});
