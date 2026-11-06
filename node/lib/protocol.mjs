import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { LIMITS, need, exact, publicKeyValid, integer, canonical, assertTime, assertFactories } from '../shared/protocol-core.mjs';
export { LIMITS, need, exact, publicKeyValid, integer, canonical, assertFactories };
const KEY = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const SPKI = '302a300506032b6570032100';
export function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function nodeId(publicKey) {
  need(publicKeyValid(publicKey), 'PUBLIC_KEY_INVALID');
  return 'realdex-node:' + createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest('hex');
}
export function createIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { schema: 'realdex.node.identity.v1',
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
}
export function assertIdentity(identity) {
  exact(identity, ['schema', 'publicKey', 'privateKey'], 'IDENTITY_INVALID');
  need(identity.schema === 'realdex.node.identity.v1' && publicKeyValid(identity.publicKey) &&
    typeof identity.privateKey === 'string' && identity.privateKey.length < 200, 'IDENTITY_INVALID');
  const privateKey = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  need(privateKey.asymmetricKeyType === 'ed25519', 'IDENTITY_INVALID');
  const actual = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('hex');
  need(actual === SPKI + identity.publicKey, 'IDENTITY_KEY_MISMATCH');
  return privateKey;
}
export function signPayload(payload, identity) {
  need(payload.publisher === identity.publicKey, 'PUBLISHER_MISMATCH');
  return { payload, signature: sign(null, Buffer.from(canonical(payload)), assertIdentity(identity)).toString('hex') };
}
function verifyEnvelope(envelope) {
  exact(envelope, ['payload', 'signature'], 'ENVELOPE_INVALID');
  need(publicKeyValid(envelope.payload?.publisher) && typeof envelope.signature === 'string' && SIG.test(envelope.signature), 'SIGNATURE_INVALID');
  const encoded = canonical(envelope.payload);
  need(Buffer.byteLength(encoded) <= LIMITS.bytes, 'MESSAGE_TOO_LARGE');
  const key = createPublicKey({ key: Buffer.from(SPKI + envelope.payload.publisher, 'hex'), format: 'der', type: 'spki' });
  need(verify(null, Buffer.from(encoded), key, Buffer.from(envelope.signature, 'hex')), 'SIGNATURE_INVALID');
  return envelope.payload;
}
export function createAnnouncement(identity, revision, factories, now = Date.now()) {
  const ordered = factories.map(x => ({ ...x })).sort((a, b) => {
    const x = a.chainId + '/' + a.address; const y = b.chainId + '/' + b.address; return x < y ? -1 : x > y ? 1 : 0;
  });
  const payload = { schema: 'realdex.node.factories.v1', publisher: identity.publicKey, revision,
    issuedAt: now, expiresAt: now + LIMITS.announcementTtlMs, factories: ordered };
  const envelope = signPayload(payload, identity); verifyAnnouncement(envelope, now); return envelope;
}
export function verifyAnnouncement(envelope, now = Date.now()) {
  const p = envelope?.payload;
  exact(p, ['schema', 'publisher', 'revision', 'issuedAt', 'expiresAt', 'factories'], 'ANNOUNCEMENT_INVALID');
  need(p.schema === 'realdex.node.factories.v1', 'ANNOUNCEMENT_INVALID');
  integer(p.revision, 1, Number.MAX_SAFE_INTEGER, 'REVISION_INVALID');
  assertFactories(p.factories); assertTime(p, now, LIMITS.announcementTtlMs); verifyEnvelope(envelope);
  return p;
}
export function createSnapshot(identity, nonce, announcements, now = Date.now()) {
  const payload = { schema: 'realdex.node.snapshot.v1', publisher: identity.publicKey, nonce,
    issuedAt: now, expiresAt: now + LIMITS.snapshotTtlMs, announcements };
  need(KEY.test(nonce) && Array.isArray(announcements) && announcements.length <= LIMITS.publishers, 'SNAPSHOT_INVALID');
  const envelope = signPayload(payload, identity);
  need(Buffer.byteLength(JSON.stringify(envelope)) <= LIMITS.bytes, 'MESSAGE_TOO_LARGE');
  return envelope;
}
export function verifySnapshot(envelope, expectedPublicKey, nonce, now = Date.now()) {
  need(publicKeyValid(expectedPublicKey) && typeof nonce === 'string' && KEY.test(nonce), 'PEER_REQUEST_INVALID');
  const p = envelope?.payload;
  exact(p, ['schema', 'publisher', 'nonce', 'issuedAt', 'expiresAt', 'announcements'], 'SNAPSHOT_INVALID');
  need(p.schema === 'realdex.node.snapshot.v1' && p.publisher === expectedPublicKey && p.nonce === nonce, 'PEER_OR_CHALLENGE_MISMATCH');
  need(Array.isArray(p.announcements) && p.announcements.length <= LIMITS.publishers, 'SNAPSHOT_LIMIT');
  assertTime(p, now, LIMITS.snapshotTtlMs); verifyEnvelope(envelope);
  return p;
}
export function catalogueFingerprint(payload) {
  return digest({ schema: payload.schema, publisher: payload.publisher, revision: payload.revision, factories: payload.factories });
}
