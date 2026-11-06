import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createIdentity, LIMITS } from '../lib/protocol.mjs';
import { RealDexNode } from '../lib/server.mjs';
import { pullPeer, getBoundedJson } from '../lib/transport.mjs';
import { config, factory, directory } from './fixtures.mjs';

async function startNode(t, identity = createIdentity(), overrides = {}, clock = Date.now, distRoot = null) {
  const c = config(overrides); const node = new RealDexNode({ identity, config: c, now: clock, distRoot });
  const address = await node.start({ port: 0, autoSync: false });
  c.allowedHosts = ['127.0.0.1:' + address.port];
  const origin = 'http://127.0.0.1:' + address.port;
  t.after(() => node.close()); return { node, origin, identity, peer: { url: origin, publicKey: identity.publicKey } };
}
async function mock(t, handler) {
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return new URL('http://127.0.0.1:' + server.address().port + '/v1/catalogue');
}
function raw(origin, requestPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(origin, { path: requestPath, method, headers }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text, headers: response.headers }));
    }); request.on('error', reject); request.end();
  });
}

test('real loopback HTTP exchanges signed origin-preserving factory catalogues', async t => {
  const a = await startNode(t, createIdentity(), { catalogue: { revision: 1, factories: [factory()] } });
  const b = await startNode(t, createIdentity(), { peers: [a.peer] });
  const s = await b.node.syncNow(); assert.equal(s.peers[0].state, 'reachable'); assert.equal(s.candidates.length, 1);
  assert.equal(s.candidates[0].sources[0].publisher, a.identity.publicKey); assert.equal(s.candidates[0].executable, false);
});
test('A -> B -> C gossip works without C connecting to A and B can go offline', async t => {
  const a = await startNode(t, createIdentity(), { catalogue: { revision: 1, factories: [factory()] } });
  const b = await startNode(t, createIdentity(), { peers: [a.peer] }); await b.node.syncNow();
  const c = await startNode(t, createIdentity(), { peers: [b.peer], publishers: [a.identity.publicKey] }); await c.node.syncNow();
  assert.equal(c.node.status().candidates[0].address, factory().address);
  assert.equal(c.node.status().candidates[0].sources[0].publisher, a.identity.publicKey);
  await b.node.close(); const s = await c.node.syncNow();
  assert.equal(s.peers[0].state, 'unavailable-or-rejected'); assert.equal(s.candidates.length, 1);
  assert.equal((await fetch(c.origin + '/node/')).status, 200);
});
test('a relayed publisher must be explicitly pinned even when the connected peer is pinned', async t => {
  const a = await startNode(t, createIdentity(), { catalogue: { revision: 1, factories: [factory()] } });
  const b = await startNode(t, createIdentity(), { peers: [a.peer] }); await b.node.syncNow();
  const c = await startNode(t, createIdentity(), { peers: [b.peer] }); const s = await c.node.syncNow();
  assert.equal(s.candidates.length, 0); assert.equal(s.peers[0].rejected, 1); assert.match(s.peers[0].code, /NOT_PINNED/);
});
test('configured peer key mismatch rejects a live response', async t => {
  const a = await startNode(t); await assert.rejects(pullPeer({ ...a.peer, publicKey: createIdentity().publicKey }), /CHALLENGE_MISMATCH/);
});
test('stale remote factories disappear when their origin heartbeat expires', async t => {
  let clock = Date.now(); const now = () => clock;
  const a = await startNode(t, createIdentity(), { catalogue: { revision: 1, factories: [factory()] } }, now);
  const b = await startNode(t, createIdentity(), { peers: [a.peer] }, now); await b.node.syncNow();
  assert.equal(b.node.status().candidates.length, 1); await a.node.close(); clock += LIMITS.announcementTtlMs;
  assert.equal(b.node.status().candidates.length, 0);
});
test('concurrent sync requests share one in-flight operation', async t => {
  const a = await startNode(t); const b = await startNode(t, createIdentity(), { peers: [a.peer] });
  const first = b.node.syncNow(); const second = b.node.syncNow(); assert.equal(first, second); await first;
});
test('node HTTP surface has no signing, custody, RPC proxy or arbitrary write endpoints', async t => {
  const a = await startNode(t);
  for (const endpoint of ['/v1/sign', '/v1/execute', '/v1/rpc', '/v1/config', '/identity.json', '/.env', '/.realdex/identity.json']) {
    assert.equal((await raw(a.origin, endpoint)).status, 404);
    assert.equal((await raw(a.origin, endpoint, {}, 'POST')).status, 405);
  }
  const status = await (await fetch(a.origin + '/v1/status')).text();
  assert.ok(!status.includes(a.identity.privateKey)); assert.ok(!status.includes('privateKey'));
  assert.equal(JSON.parse(status).walletSigning, false); assert.equal(JSON.parse(status).custody, false);
});
test('DNS rebinding-style Host and cross-origin browser requests are rejected', async t => {
  const a = await startNode(t);
  assert.equal((await raw(a.origin, '/v1/status', { host: 'evil.example' })).status, 421);
  assert.equal((await raw(a.origin, '/v1/status', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await raw(a.origin, '/v1/status', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await raw(a.origin, '/v1/status', { origin: a.origin })).status, 200);
});
test('path traversal, encoded paths and parameter smuggling reject', async t => {
  const a = await startNode(t);
  for (const url of ['/node/../identity.json', '/%2e%2e/identity.json', '//evil.example/', '/v1/status?x=y', '/v1/catalogue?nonce=' + 'a'.repeat(64) + '&nonce=' + 'b'.repeat(64)]) {
    assert.equal((await raw(a.origin, url)).status, 400);
  }
  assert.equal((await raw(a.origin, '/v1/catalogue')).status, 400);
});
test('console serves real JS/CSS and denies framing without allowing any cross-origin RPC', async t => {
  const a = await startNode(t); const page = await raw(a.origin, '/node/');
  assert.equal(page.status, 200); assert.match(page.text, /RealDEX/);
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/); assert.equal(page.headers['x-frame-options'], 'DENY');
  for (const p of ['/node/console.mjs', '/node/styles.css', '/node/optimizer/demo-data.mjs']) assert.equal((await raw(a.origin, p)).status, 200);
  assert.equal((await raw(a.origin, '/node/', {}, 'HEAD')).text, '');
  assert.equal((await raw(a.origin, '/favicon.ico')).status, 204);
});
test('optional static DEX hosting only exposes root index and recognized assets', async t => {
  const dir = directory(t); fs.mkdirSync(path.join(dir, 'assets')); fs.writeFileSync(path.join(dir, 'index.html'), '<h1>test build</h1>');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("test");'); fs.writeFileSync(path.join(dir, 'identity.json'), 'not allowed');
  fs.symlinkSync(path.join(dir, 'identity.json'), path.join(dir, 'assets', 'secret.json'));
  const a = await startNode(t, createIdentity(), { serveDex: true }, Date.now, dir);
  assert.equal((await raw(a.origin, '/')).status, 200); assert.equal((await raw(a.origin, '/assets/app.js')).status, 200);
  assert.equal((await raw(a.origin, '/identity.json')).status, 404); assert.equal((await raw(a.origin, '/assets/secret.json')).status, 404);
  assert.equal((await raw(a.origin, '/assets/missing.js')).status, 404);
});
test('peer HTTP redirects are not followed', async t => {
  let redirected = 0; const target = await mock(t, (_req, res) => { redirected++; res.end('{}'); });
  const url = await mock(t, (_req, res) => { res.writeHead(302, { location: target.toString() }); res.end(); });
  await assert.rejects(getBoundedJson(url), /PEER_RESPONSE_INVALID/); assert.equal(redirected, 0);
});
test('peer response byte limits enforce both Content-Length and streamed bytes', async t => {
  for (const lengthHeader of [false, true]) {
    const url = await mock(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', ...(lengthHeader ? { 'content-length': 1000 } : {}) }); res.end('x'.repeat(1000)); });
    await assert.rejects(getBoundedJson(url, { maximumBytes: 100 }), /PEER_RESPONSE_TOO_LARGE/);
  }
});
test('malformed UTF-8, malformed JSON and compressed data are rejected', async t => {
  for (const [body, headers, code] of [[Buffer.from([0xff]), {}, 'PEER_JSON_INVALID'], ['{', {}, 'PEER_JSON_INVALID'], ['{}', { 'content-encoding': 'gzip' }, 'PEER_RESPONSE_INVALID']]) {
    const url = await mock(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(body); });
    await assert.rejects(getBoundedJson(url), new RegExp(code));
  }
});
test('timeout bounds a peer that never sends headers', async t => {
  const url = await mock(t, () => {}); await assert.rejects(getBoundedJson(url, { timeoutMs: 40 }), /PEER_TIMEOUT/);
});
test('incoming API rate limit is bounded and does not create an unbounded per-IP map', async t => {
  const clock = Date.now(); const a = await startNode(t, createIdentity(), {}, () => clock);
  let limited = 0;
  for (let i = 0; i < 65; i++) if ((await raw(a.origin, '/v1/identity')).status === 429) limited++;
  assert.equal(limited, 5);
});
test('fetch primitive rejects non-HTTPS remote URLs, URL credentials, fragments and unsupported protocols', () => {
  for (const value of ['http://example.com/', 'http://localhost/', 'https://a:b@example.com/', 'https://example.com/#x', 'file:///etc/passwd']) {
    assert.throws(() => getBoundedJson(new URL(value)), /FETCH_URL_INVALID/);
  }
});
