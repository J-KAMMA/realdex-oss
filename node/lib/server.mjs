import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Catalogue, HeadStore } from './store.mjs';
import { createAnnouncement, createSnapshot, LIMITS, need, nodeId } from './protocol.mjs';
import { pullPeer } from './transport.mjs';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_FILES = new Map([
  ['/node/spot/', ['public/spot.html', 'text/html; charset=utf-8']],
  ['/node/spot-ui.mjs', ['public/spot-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/node/spot.css', ['public/spot.css', 'text/css; charset=utf-8']],
  ['/node/external/math.mjs', ['external/math.mjs', 'text/javascript; charset=utf-8']],
  ['/node/external/protobuf.mjs', ['external/protobuf.mjs', 'text/javascript; charset=utf-8']],
  ['/node/external/transport.mjs', ['external/transport.mjs', 'text/javascript; charset=utf-8']],
  ['/node/external/market.mjs', ['external/market.mjs', 'text/javascript; charset=utf-8']],
  ['/node/external/quote.mjs', ['external/quote.mjs', 'text/javascript; charset=utf-8']],
  ['/node/external/observer.mjs', ['external/observer.mjs', 'text/javascript; charset=utf-8']],
  ['/node/external/demo.mjs', ['external/demo.mjs', 'text/javascript; charset=utf-8']],

  ['/node/privacy/', ['public/privacy.html', 'text/html; charset=utf-8']],
  ['/node/privacy.mjs', ['public/privacy.mjs', 'text/javascript; charset=utf-8']],
  ['/node/privacy.css', ['public/privacy.css', 'text/css; charset=utf-8']],
  ['/node/extended/guard.mjs', ['extended/guard.mjs', 'text/javascript; charset=utf-8']],
  ['/node/extended/json.mjs', ['extended/json.mjs', 'text/javascript; charset=utf-8']],
  ['/node/extended/http.mjs', ['extended/http.mjs', 'text/javascript; charset=utf-8']],
  ['/node/extended/registry.mjs', ['extended/registry.mjs', 'text/javascript; charset=utf-8']],
  ['/node/extended/protocol.mjs', ['extended/protocol.mjs', 'text/javascript; charset=utf-8']],
  ['/node/extended/observe.mjs', ['extended/observe.mjs', 'text/javascript; charset=utf-8']],
  ['/node/icp/principal.mjs', ['icp/principal.mjs', 'text/javascript; charset=utf-8']],
  ['/node/icp/cbor.mjs', ['icp/cbor.mjs', 'text/javascript; charset=utf-8']],
  ['/node/icp/candid.mjs', ['icp/candid.mjs', 'text/javascript; charset=utf-8']],
  ['/node/icp/reader.mjs', ['icp/reader.mjs', 'text/javascript; charset=utf-8']],
  ['/node/extended/networks.json', ['extended/networks.json', 'application/json; charset=utf-8']],
  ['/node/icp/ledgers.json', ['icp/ledgers.json', 'application/json; charset=utf-8']],
  ['/node/chains/', ['public/chains.html', 'text/html; charset=utf-8']],
  ['/node/chains.mjs', ['public/chains.mjs', 'text/javascript; charset=utf-8']],
  ['/node/chains.css', ['public/chains.css', 'text/css; charset=utf-8']],
  ['/node/chains/profiles.json', ['chains/profiles.json', 'application/json; charset=utf-8']],
  ['/node/chains/core.mjs', ['chains/core.mjs', 'text/javascript; charset=utf-8']],
  ['/node/chains/registry.mjs', ['chains/registry.mjs', 'text/javascript; charset=utf-8']],
  ['/node/chains/transport.mjs', ['chains/transport.mjs', 'text/javascript; charset=utf-8']],
  ['/node/chains/adapters.mjs', ['chains/adapters.mjs', 'text/javascript; charset=utf-8']],
  ['/node/chains/observation.mjs', ['chains/observation.mjs', 'text/javascript; charset=utf-8']],
  ['/node/chains/assets.mjs', ['chains/assets.mjs', 'text/javascript; charset=utf-8']],

  ['/node/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/node/exchange/', ['public/exchange.html', 'text/html; charset=utf-8']],
  ['/node/exchange.mjs', ['public/exchange.mjs', 'text/javascript; charset=utf-8']],
  ['/node/exchange.css', ['public/exchange.css', 'text/css; charset=utf-8']],
  ['/node/shared/protocol-core.mjs', ['shared/protocol-core.mjs', 'text/javascript; charset=utf-8']],
  ['/node/verified/catalogue.mjs', ['verified/catalogue.mjs', 'text/javascript; charset=utf-8']],
  ['/node/verified/keccak.mjs', ['verified/keccak.mjs', 'text/javascript; charset=utf-8']],
  ['/node/verified/rpc.mjs', ['verified/rpc.mjs', 'text/javascript; charset=utf-8']],
  ['/node/verified/evm.mjs', ['verified/evm.mjs', 'text/javascript; charset=utf-8']],
  ['/node/console.mjs', ['public/console.mjs', 'text/javascript; charset=utf-8']],
  ['/node/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/node/optimizer/quote-objective.mjs', ['optimizer/quote-objective.mjs', 'text/javascript; charset=utf-8']],
  ['/node/optimizer/discrete-split.mjs', ['optimizer/discrete-split.mjs', 'text/javascript; charset=utf-8']],
  ['/node/optimizer/demo-data.mjs', ['optimizer/demo-data.mjs', 'text/javascript; charset=utf-8']]
]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const safeCode = e => e instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(e.message) ? e.message : 'OPERATION_FAILED';

export class RealDexNode {
  constructor({ identity, config, heads = new HeadStore(), now = Date.now, distRoot = null }) {
    this.identity = identity; this.config = config; this.now = now; this.distRoot = distRoot;
    need(!config.serveDex || distRoot, 'DEX_BUILD_UNAVAILABLE');
    const publishers = [...new Set([identity.publicKey, ...config.publishers, ...config.peers.map(p => p.publicKey)])];
    need(publishers.length <= LIMITS.publishers, 'PUBLISHER_POLICY_LIMIT');
    this.catalogue = new Catalogue(publishers, heads); this.peerStatus = new Map();
    this.timer = null; this.syncPromise = null; this.server = null; this.stopped = false;
    this.budget = { resetAt: 0, remaining: 60 }; this.lastLocalIssued = 0; this.fatal = null;
    this.refreshLocal();
  }
  refreshLocal() {
    const now = this.now();
    if (now < this.lastLocalIssued) throw new Error('CLOCK_MOVED_BACKWARDS');
    if (now - this.lastLocalIssued >= 1000 || !this.lastLocalIssued) {
      this.catalogue.accept(createAnnouncement(this.identity, this.config.catalogue.revision, this.config.catalogue.factories, now), now);
      this.lastLocalIssued = now;
    }
  }
  status() {
    this.refreshLocal();
    return { schema: 'realdex.node.status.v1', nodeId: nodeId(this.identity.publicKey), publicKey: this.identity.publicKey,
      mode: 'read-only-discovery-preview', walletSigning: false, custody: false, bridgeValidator: false,
      automaticPeerDiscovery: false, natTraversal: false, dexServed: Boolean(this.distRoot),
      fatal: this.fatal, peers: this.config.peers.map(p => ({ publicKey: p.publicKey,
        ...(this.peerStatus.get(p.publicKey) ?? { state: 'not-contacted', observedAt: null, accepted: 0, rejected: 0, code: null }) })),
      candidates: this.catalogue.candidates(this.now()) };
  }
  syncNow() {
    if (this.stopped) return Promise.reject(new Error('NODE_STOPPED'));
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync().finally(() => { this.syncPromise = null; });
    return this.syncPromise;
  }
  async performSync() {
    this.refreshLocal();
    // Four bounded requests at a time; the full interval cannot pile up requests.
    for (let offset = 0; offset < this.config.peers.length && !this.stopped; offset += 4) {
      await Promise.all(this.config.peers.slice(offset, offset + 4).map(async peer => {
        try {
          const announcements = await pullPeer(peer, { now: this.now });
          let accepted = 0; let rejected = 0; const codes = new Set();
          for (const announcement of announcements) {
            try { this.catalogue.accept(announcement, this.now()); accepted++; }
            catch (error) { rejected++; codes.add(safeCode(error)); }
          }
          this.peerStatus.set(peer.publicKey, { state: 'reachable', observedAt: this.now(), accepted, rejected, code: [...codes].join(',') || null });
        } catch (error) {
          this.peerStatus.set(peer.publicKey, { state: 'unavailable-or-rejected', observedAt: this.now(), accepted: 0, rejected: 0, code: safeCode(error) });
        }
      }));
    }
    return this.status();
  }
  async start({ port = this.config.port, autoSync = true } = {}) {
    need(!this.server, 'NODE_ALREADY_STARTED');
    this.server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (req, res) => this.handle(req, res));
    this.server.maxConnections = 64; this.server.maxRequestsPerSocket = 20;
    this.server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    await new Promise((resolve, reject) => {
      const onError = error => reject(error); this.server.once('error', onError);
      this.server.listen(port, this.config.host, () => { this.server.removeListener('error', onError); resolve(); });
    });
    this.server.on('error', error => { this.fatal = safeCode(error); });
    if (autoSync) {
      const tick = () => { this.syncNow().catch(error => { this.fatal = safeCode(error); }); };
      this.timer = setInterval(tick, this.config.syncIntervalMs); this.timer.unref(); tick();
    }
    return this.server.address();
  }
  async close() {
    this.stopped = true; clearInterval(this.timer);
    if (this.syncPromise) await this.syncPromise.catch(() => {});
    if (this.server?.listening) {
      const closed = new Promise(resolve => this.server.close(resolve)); this.server.closeAllConnections(); await closed;
    }
  }
  handle(req, res) {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
    const send = (code, body, contentType = 'application/json; charset=utf-8', more = {}) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(code, { ...headers, 'content-type': contentType, ...more }); res.end(body);
    };
    const failure = (code, reason) => send(code, JSON.stringify({ error: reason }));
    try {
      const host = req.headers.host;
      if (!host || !this.config.allowedHosts.includes(host.toLowerCase())) return failure(421, 'HOST_NOT_ALLOWED');
      if (req.method !== 'GET' && req.method !== 'HEAD') return failure(405, 'READ_ONLY_NODE');
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) return failure(400, 'REQUEST_BODY_FORBIDDEN');
      if (req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin); } catch { return failure(403, 'ORIGIN_NOT_ALLOWED'); }
        if (!['http:', 'https:'].includes(origin.protocol) || origin.host.toLowerCase() !== host.toLowerCase()) return failure(403, 'ORIGIN_NOT_ALLOWED');
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') return failure(403, 'ORIGIN_NOT_ALLOWED');
      if (!req.url || req.url.length > 1024 || !req.url.startsWith('/') || req.url.startsWith('//') || /[%\\\x00-\x20\x7f]/.test(req.url) || req.url.split('?')[0].split('/').includes('..')) return failure(400, 'PATH_INVALID');
      const url = new URL(req.url, 'http://' + host);
      if (url.pathname !== '/v1/catalogue' && url.search) return failure(400, 'QUERY_INVALID');
      if (url.pathname.startsWith('/v1/')) {
        const now = this.now();
        if (now >= this.budget.resetAt) this.budget = { resetAt: now + 1000, remaining: 60 };
        if (this.budget.remaining-- <= 0) return failure(429, 'RATE_LIMIT');
      }
      if (url.pathname === '/v1/identity') {
        return send(200, JSON.stringify({ schema: 'realdex.node.public-identity.v1', publicKey: this.identity.publicKey,
          nodeId: nodeId(this.identity.publicKey), warning: 'Self-asserted identity: verify the public key out of band.' }));
      }
      if (url.pathname === '/v1/catalogue') {
        if (req.method !== 'GET') return failure(405, 'GET_REQUIRED');
        const nonce = url.searchParams.get('nonce');
        if ([...url.searchParams.keys()].length !== 1 || !nonce || !/^[0-9a-f]{64}$/.test(nonce)) return failure(400, 'CHALLENGE_REQUIRED');
        this.refreshLocal(); const now = this.now();
        return send(200, JSON.stringify(createSnapshot(this.identity, nonce, this.catalogue.export(now), now)));
      }
      if (url.pathname === '/v1/status') return send(200, JSON.stringify(this.status()));
      if (url.pathname === '/favicon.ico') return send(204, '', 'image/x-icon');
      if (url.pathname === '/node') return send(302, '', 'text/plain', { location: '/node/' });
      const fixed = PUBLIC_FILES.get(url.pathname);
      if (fixed) {
        // Only this explicit read-only page may query caller-chosen external RPCs.
        const extra = ['/node/exchange/', '/node/chains/', '/node/privacy/', '/node/spot/'].includes(url.pathname) ? { 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https: http://127.0.0.1:* http://localhost:* http://[::1]:*; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" } : {};
        return send(200, req.method === 'HEAD' ? '' : fs.readFileSync(path.join(moduleRoot, fixed[0])), fixed[1], extra);
      }
      if (this.distRoot) {
        const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const extension = path.extname(relative);
        if (!MIME[extension] || (relative !== 'index.html' && !relative.startsWith('assets/'))) return failure(404, 'NOT_FOUND');
        const target = path.resolve(this.distRoot, relative);
        if (!target.startsWith(this.distRoot + path.sep)) return failure(404, 'NOT_FOUND');
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024 || !fs.realpathSync(target).startsWith(fs.realpathSync(this.distRoot) + path.sep)) return failure(404, 'NOT_FOUND');
        const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss: http://127.0.0.1:8545; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";
        return send(200, req.method === 'HEAD' ? '' : fs.readFileSync(target), MIME[extension], { 'content-security-policy': csp });
      }
      if (url.pathname === '/') return send(302, '', 'text/plain', { location: '/node/' });
      return failure(404, 'NOT_FOUND');
    } catch (error) {
      return failure(error?.code === 'ENOENT' ? 404 : 503, error?.code === 'ENOENT' ? 'NOT_FOUND' : safeCode(error));
    }
  }
}
