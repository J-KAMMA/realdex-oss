import { LIMITS, need, exact, publicKeyValid, integer, canonical, assertTime, assertFactories } from '../shared/protocol-core.mjs';
import { fromHex, toHex } from './keccak.mjs';

const encoder = new TextEncoder();
/** Verify the original publisher, not just the relay. A publisher key is not pool approval. */
async function verifySignature(envelope) {
  exact(envelope, ['payload','signature'], 'ENVELOPE_INVALID');
  need(publicKeyValid(envelope.payload?.publisher) && typeof envelope.signature === 'string' && /^[0-9a-f]{128}$/.test(envelope.signature), 'SIGNATURE_INVALID');
  const encoded = encoder.encode(canonical(envelope.payload));
  need(encoded.length <= LIMITS.bytes, 'MESSAGE_TOO_LARGE');
  need(globalThis.crypto?.subtle, 'WEB_CRYPTO_REQUIRED');
  const key = await crypto.subtle.importKey('raw', fromHex('0x'+envelope.payload.publisher), 'Ed25519', false, ['verify']);
  need(await crypto.subtle.verify('Ed25519', key, fromHex('0x'+envelope.signature), encoded), 'SIGNATURE_INVALID');
}
export function challenge() {
  need(globalThis.crypto?.getRandomValues, 'WEB_CRYPTO_REQUIRED');
  return toHex(crypto.getRandomValues(new Uint8Array(32))).slice(2);
}
export async function readBoundedJson(response, maximumBytes = LIMITS.bytes) {
  need(response.ok, 'HTTP_RESPONSE_REJECTED');
  need(/^(application\/json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'JSON_CONTENT_TYPE_REQUIRED');
  const declared = response.headers.get('content-length');
  need(declared === null || (/^\d{1,9}$/.test(declared) && Number(declared) <= maximumBytes), 'MESSAGE_TOO_LARGE');
  need(response.body?.getReader, 'STREAMING_RESPONSE_REQUIRED');
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      total += value.byteLength; need(total <= maximumBytes, 'MESSAGE_TOO_LARGE'); chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); } catch { throw new Error('JSON_INVALID'); }
}
export function safeEndpoint(value, { base, sameOrigin = false } = {}) {
  let url; try { url = new URL(value, base); } catch { throw new Error('ENDPOINT_INVALID'); }
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  need(url.href.length <= 2048 && !url.username && !url.password && !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)), 'ENDPOINT_UNSAFE');
  if (sameOrigin) need(base && url.origin === new URL(base).origin, 'SAME_ORIGIN_REQUIRED');
  return url;
}
/** Session-local rollback/equivocation guard. Each instance is explicitly bound to
 * one relay key and a bounded source-key policy. Reload resets heads; challenge
 * freshness is still checked, but persistent anti-rollback is the node's job. */
export class VerifiedCatalogue {
  #relay; #allowed; #heads = new Map(); #clock; #lastNow = 0; #pending = false;
  constructor({ relayPublicKey, publisherKeys, now = Date.now }) {
    need(publicKeyValid(relayPublicKey) && Array.isArray(publisherKeys) && publisherKeys.length >= 1 &&
      publisherKeys.length <= LIMITS.publishers && publisherKeys.every(publicKeyValid) &&
      new Set(publisherKeys).size === publisherKeys.length, 'PUBLISHER_POLICY_INVALID');
    this.#relay = relayPublicKey; this.#allowed = new Set(publisherKeys); this.#clock = now;
  }
  #time() { const n = this.#clock(); integer(n,1,Number.MAX_SAFE_INTEGER,'CLOCK_INVALID'); need(n >= this.#lastNow,'CLOCK_MOVED_BACKWARDS'); this.#lastNow = n; return n; }
  async verify(value, nonce) {
    need(!this.#pending, 'CATALOGUE_VERIFICATION_IN_PROGRESS'); this.#pending = true;
    try {
      const envelope = structuredClone(value), p = envelope?.payload, now = this.#time();
      need(typeof nonce === 'string' && /^[0-9a-f]{64}$/.test(nonce), 'CHALLENGE_INVALID');
      exact(p,['schema','publisher','nonce','issuedAt','expiresAt','announcements'],'SNAPSHOT_INVALID');
      need(p.schema === 'realdex.node.snapshot.v1' && p.publisher === this.#relay && p.nonce === nonce, 'PEER_OR_CHALLENGE_MISMATCH');
      need(Array.isArray(p.announcements) && p.announcements.length <= LIMITS.publishers,'SNAPSHOT_LIMIT');
      assertTime(p,now,LIMITS.snapshotTtlMs); await verifySignature(envelope);
      const nextHeads = new Map(this.#heads), seen = new Set(), candidates = new Map(), rejected = [];
      for (const item of p.announcements) {
        const source = item?.payload?.publisher;
        need(publicKeyValid(source) && !seen.has(source),'DUPLICATE_OR_INVALID_PUBLISHER'); seen.add(source);
        try {
          need(this.#allowed.has(source),'PUBLISHER_NOT_ALLOWED');
          const a = item.payload;
          exact(a,['schema','publisher','revision','issuedAt','expiresAt','factories'],'ANNOUNCEMENT_INVALID');
          need(a.schema === 'realdex.node.factories.v1','ANNOUNCEMENT_INVALID');
          integer(a.revision,1,Number.MAX_SAFE_INTEGER,'REVISION_INVALID'); assertFactories(a.factories); assertTime(a,now,LIMITS.announcementTtlMs);
          await verifySignature(item);
          const content = canonical({schema:a.schema,publisher:source,revision:a.revision,factories:a.factories}), previous = nextHeads.get(source);
          need(!previous || a.revision >= previous.revision,'CATALOGUE_ROLLBACK');
          need(!previous || a.revision !== previous.revision || previous.content === content,'CATALOGUE_EQUIVOCATION');
          nextHeads.set(source,{revision:a.revision,content});
          for (const f of a.factories) {
            const id = `${f.chainId}/${f.address}`;
            if (!candidates.has(id)) candidates.set(id,{...f,sources:[]});
            candidates.get(id).sources.push({publicKey:source,revision:a.revision,expiresAt:a.expiresAt});
          }
        } catch (error) { rejected.push({publicKey:source,code: error instanceof Error ? error.message : 'ANNOUNCEMENT_REJECTED'}); }
      }
      const finished = this.#time(); assertTime(p,finished,LIMITS.snapshotTtlMs);
      // An announcement may expire during cryptographic work; don't publish it.
      for (const [id,c] of candidates) { c.sources = c.sources.filter(s => s.expiresAt > finished); if (!c.sources.length) candidates.delete(id); }
      this.#heads = nextHeads;
      return {schema:'realdex.verified-catalogue.v1',relayPublicKey:this.#relay,observedAt:finished,expiresAt:p.expiresAt,
        candidates:[...candidates.values()].sort((a,b) => (a.chainId+'/'+a.address).localeCompare(b.chainId+'/'+b.address)), rejected, executable:false};
    } finally { this.#pending = false; }
  }
  async pull(endpoint, { fetchImpl = globalThis.fetch, signal, timeoutMs = 8000, base, sameOrigin = false } = {}) {
    integer(timeoutMs,100,30000,'TIMEOUT_INVALID');
    const url = safeEndpoint(endpoint,{base,sameOrigin}); need(!url.search,'CATALOGUE_ENDPOINT_QUERY_FORBIDDEN');
    const nonce = challenge(); url.pathname = url.pathname.replace(/\/$/,'') + '/v1/catalogue'; url.searchParams.set('nonce',nonce);
    const joined = signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url.href,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:joined,headers:{accept:'application/json'}});
    const value = await readBoundedJson(response); joined.throwIfAborted();
    const result = await this.verify(value,nonce); joined.throwIfAborted(); return result;
  }
}
