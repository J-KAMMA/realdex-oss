import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { LIMITS, need, verifySnapshot } from './protocol.mjs';
import { peerUrl } from './config.mjs';

// Explicit operator-selected destinations only. No redirects, proxy, arbitrary URL
// method, compression, credentials, peer-advertised dialling, or JSON-RPC forwarding.
export function getBoundedJson(url, { timeoutMs = 4000, maximumBytes = LIMITS.bytes } = {}) {
  need(url instanceof URL && !url.username && !url.password && !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))), 'FETCH_URL_INVALID');
  need(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 10000 && Number.isInteger(maximumBytes) &&
    maximumBytes > 0 && maximumBytes <= LIMITS.bytes, 'FETCH_POLICY_INVALID');
  return new Promise((resolve, reject) => {
    let completed = false; let timer;
    const done = (error, value) => { if (completed) return; completed = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, { agent: false, maxHeaderSize: 8192,
      headers: { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'RealDEX-Node-Preview/0.3' } }, response => {
      if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '') ||
        (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(); done(new Error('PEER_RESPONSE_INVALID')); return;
      }
      const length = response.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) {
        response.destroy(); done(new Error('PEER_RESPONSE_TOO_LARGE')); return;
      }
      let total = 0; const chunks = [];
      response.on('data', chunk => {
        total += chunk.length;
        if (total > maximumBytes) { response.destroy(); done(new Error('PEER_RESPONSE_TOO_LARGE')); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { done(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
        catch { done(new Error('PEER_JSON_INVALID')); }
      });
      response.on('error', () => done(new Error('PEER_RESPONSE_ABORTED')));
    });
    request.on('error', () => done(new Error('PEER_UNAVAILABLE')));
    timer = setTimeout(() => { done(new Error('PEER_TIMEOUT')); request.destroy(); }, timeoutMs);
  });
}
export async function pullPeer(peer, { timeoutMs = 4000, now = Date.now } = {}) {
  const origin = peerUrl(peer.url); const nonce = randomBytes(32).toString('hex');
  const envelope = await getBoundedJson(new URL('/v1/catalogue?nonce=' + nonce, origin), { timeoutMs });
  return verifySnapshot(envelope, peer.publicKey, nonce, now()).announcements;
}
