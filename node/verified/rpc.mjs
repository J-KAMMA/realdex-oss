import { need, integer, exact, canonical } from '../shared/protocol-core.mjs';
import { safeEndpoint, readBoundedJson } from './catalogue.mjs';

const METHODS = new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_estimateGas','eth_gasPrice']);
const HASH = /^0x[0-9a-fA-F]{64}$/;
export function quantity(value) {
  need(typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value),'RPC_QUANTITY_INVALID');
  return BigInt(value);
}
export function rpcHex(value, maximumBytes = 131072) {
  need(typeof value === 'string' && value.length <= 2+maximumBytes*2 && /^0x(?:[0-9a-fA-F]{2})*$/.test(value),'RPC_HEX_INVALID');
  return value.toLowerCase();
}
const hex = n => '0x'+n.toString(16);
/** No eth_send*, signing, accounts, wallet, subscriptions, redirects or RPC URLs
 * supplied by a peer. The caller chooses the endpoints out of band. */
export function createReadOnlyRpc(endpoint, {fetchImpl = globalThis.fetch, timeoutMs = 8000, signal} = {}) {
  const url = safeEndpoint(endpoint); integer(timeoutMs,100,30000,'TIMEOUT_INVALID');
  let sequence = 0, active = 0; const waiting = [];
  async function acquire(joined) {
    joined.throwIfAborted();
    if (active < 4) { active++; return; }
    need(waiting.length < 128,'RPC_QUEUE_LIMIT');
    await new Promise((resolve,reject) => {
      const item = {resolve: () => { joined.removeEventListener('abort',abort); resolve(); }};
      const abort = () => { const i = waiting.indexOf(item); if (i >= 0) waiting.splice(i,1); reject(joined.reason); };
      joined.addEventListener('abort',abort,{once:true}); waiting.push(item);
    });
    // A departing holder transfers its permit directly to this waiter.
  }
  return Object.freeze({ id:url.href, displayId:url.origin,
    async send(method, params) {
      need(METHODS.has(method),'RPC_METHOD_FORBIDDEN');
      need(Array.isArray(params),'RPC_PARAMS_INVALID');
      const id = ++sequence, body = JSON.stringify({jsonrpc:'2.0',id,method,params});
      need(body.length <= 16384,'RPC_REQUEST_TOO_LARGE');
      const timeout = AbortSignal.timeout(timeoutMs), joined = signal ? AbortSignal.any([signal,timeout]) : timeout;
      // A queue slot is released even if the request is aborted before fetch.
      let acquired = false;
      try {
        await acquire(joined); acquired = true; joined.throwIfAborted();
        const response = await fetchImpl(url.href,{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:joined,
          headers:{'content-type':'application/json',accept:'application/json'},body});
        const result = await readBoundedJson(response,524288); joined.throwIfAborted();
        need(result && result.jsonrpc === '2.0' && result.id === id && !Array.isArray(result),'RPC_RESPONSE_ID_MISMATCH');
        if (Object.hasOwn(result,'error')) {
          need(!Object.hasOwn(result,'result') && result.error && Number.isInteger(result.error.code),'RPC_RESPONSE_INVALID');
          // Do not reflect untrusted RPC messages (URLs, HTML, enormous strings) into UI/logs.
          const error = new Error('RPC_REMOTE_ERROR'); error.rpcCode = result.error.code; throw error;
        }
        exact(result,['jsonrpc','id','result'],'RPC_RESPONSE_INVALID'); return result.result;
      } finally {
        if (acquired) { const next=waiting.shift(); if (next) next.resolve(); else active--; }
      }
    }
  });
}
function parseBlock(value) {
  need(value && typeof value === 'object' && !Array.isArray(value) && HASH.test(value.hash ?? ''),'RPC_BLOCK_INVALID');
  const number = quantity(value.number), timestamp = quantity(value.timestamp);
  need(timestamp > 0n && timestamp <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER/1000)),'RPC_BLOCK_TIME_INVALID');
  return {number,hash:value.hash.toLowerCase(),timestampMs:Number(timestamp)*1000};
}
const DEFAULT = Object.freeze({confirmations:2,maxAgeMs:120000,ttlMs:30000,maxHeadGap:12});
/** An observation, NOT consensus or transaction authorization. At least two caller
 * selected RPC endpoints must agree. EIP-1898 is mandatory; no latest fallback. */
export class PinnedReadSession {
  #readers; #chain; #clock; #signal; #lastNow; #options; #cache = new Map(); #invalid = null; #anchor;
  constructor(token, options) {
    need(token === CONSTRUCT,'SESSION_CONSTRUCTOR_PRIVATE');
    this.#readers = options.readers; this.#chain = options.chain; this.#clock = options.now;
    this.#signal = options.signal; this.#lastNow = options.start; this.#options = options.policy;
    this.#anchor = Object.freeze(options.anchor);
  }
  get anchor() { return this.#anchor; }
  get readerIds() { return this.#readers.map(r => r.displayId ?? r.id); }
  time() {
    this.#signal?.throwIfAborted();
    need(!this.#invalid,this.#invalid ?? 'SESSION_INVALID');
    const now = this.#clock(); integer(now,1,Number.MAX_SAFE_INTEGER,'CLOCK_INVALID');
    if (now < this.#lastNow) { this.#invalid = 'CLOCK_MOVED_BACKWARDS'; throw new Error(this.#invalid); }
    this.#lastNow = now;
    if (now >= this.#anchor.expiresAt) { this.#invalid = 'SNAPSHOT_EXPIRED'; throw new Error(this.#invalid); }
    return now;
  }
  async #all(method,params) {
    this.time();
    const values = await Promise.all(this.#readers.map(r => r.send(method,structuredClone(params))));
    this.time(); return values;
  }
  async read(method,params) {
    need(['eth_getCode','eth_call'].includes(method),'PINNED_METHOD_FORBIDDEN');
    need(Array.isArray(params) && params.length === 1,'PINNED_PARAMS_INVALID');
    this.time();
    const key = method+canonical(params);
    if (!this.#cache.has(key)) {
      const copied = structuredClone(params);
      const task = this.#all(method,[...copied,{blockHash:this.#anchor.hash,requireCanonical:true}]).then(values => {
        const bytes = values.map(v => rpcHex(v));
        if (!bytes.every(v => v === bytes[0])) { this.#invalid = 'RPC_DISAGREEMENT'; throw new Error(this.#invalid); }
        return bytes[0];
      }).catch(error => { this.#cache.delete(key); throw error; });
      this.#cache.set(key,task);
    }
    const value = await this.#cache.get(key); this.time(); return value;
  }
  async verifyCurrent() {
    this.time();
    try {
      const [chains,blocks] = await Promise.all([
        this.#all('eth_chainId',[]),this.#all('eth_getBlockByNumber',[hex(this.#anchor.number),false])]);
      need(chains.every(c => quantity(c) === this.#chain),'RPC_CHAIN_CHANGED');
      const parsed = blocks.map(parseBlock);
      need(parsed.every(b => b.number === this.#anchor.number && b.hash === this.#anchor.hash && b.timestampMs === this.#anchor.timestampMs),'SNAPSHOT_REORG');
      this.time(); return true;
    } catch (error) { this.#invalid = error instanceof Error ? error.message : 'SNAPSHOT_RECHECK_FAILED'; throw error; }
  }
  /** Advisory estimate: eth_estimateGas is not covered by EIP-1898. The explicit
   * block number is bracketed by hash rechecks. Different estimates use the max.
   * No state overrides, allowances, transactions or wallet methods are created. */
  async estimateGas(transaction) {
    await this.verifyCurrent();
    const [gas,prices] = await Promise.all([
      this.#all('eth_estimateGas',[structuredClone(transaction),hex(this.#anchor.number)]),
      this.#all('eth_gasPrice',[])]);
    const amounts = gas.map(quantity), pricesWei = prices.map(quantity);
    need(amounts.every(v => v > 0n && v <= 30000000n) && pricesWei.every(v => v > 0n),'GAS_ESTIMATE_INVALID');
    await this.verifyCurrent();
    return Object.freeze({gasUnits:amounts.reduce((a,b) => a>b?a:b),gasPriceWei:pricesWei.reduce((a,b) => a>b?a:b),
      method:'max-of-rpc-estimates-at-bracketed-block-number',asOf:this.time(),expiresAt:this.#anchor.expiresAt});
  }
}
const CONSTRUCT = Symbol('pinned-read-session');
export async function openPinnedReadSession({readers,chainId,now = Date.now,signal,policy = {}}) {
  need(Array.isArray(readers) && readers.length >= 2 && readers.length <= 4 && readers.every(r => typeof r.id === 'string' && r.id.length>0 && typeof r.send === 'function') &&
    new Set(readers.map(r => r.id)).size === readers.length,'DISTINCT_RPC_READERS_REQUIRED');
  need(typeof chainId === 'string' && /^eip155:[1-9][0-9]{0,19}$/.test(chainId),'CHAIN_ID_INVALID');
  need(policy && Object.getPrototypeOf(policy) === Object.prototype && Object.keys(policy).every(k => Object.hasOwn(DEFAULT,k)),'READ_POLICY_INVALID');
  const p = {...DEFAULT,...policy};
  integer(p.confirmations,1,64,'READ_POLICY_INVALID'); integer(p.maxAgeMs,1000,600000,'READ_POLICY_INVALID');
  integer(p.ttlMs,1000,60000,'READ_POLICY_INVALID'); integer(p.maxHeadGap,0,64,'READ_POLICY_INVALID');
  const captured = readers.map(r => ({id:r.id,displayId:r.displayId,send:r.send.bind(r)}));
  const chain = BigInt(chainId.slice(7)), start = now(); integer(start,1,Number.MAX_SAFE_INTEGER-p.ttlMs,'CLOCK_INVALID'); signal?.throwIfAborted();
  const chains = await Promise.all(captured.map(r => r.send('eth_chainId',[])));
  need(chains.every(c => quantity(c) === chain),'RPC_CHAIN_MISMATCH');
  const heads = (await Promise.all(captured.map(r => r.send('eth_getBlockByNumber',['latest',false])))).map(parseBlock);
  const lowest = heads.reduce((a,b) => a.number<b.number?a:b).number, highest = heads.reduce((a,b) => a.number>b.number?a:b).number;
  need(highest-lowest <= BigInt(p.maxHeadGap),'RPC_HEADS_TOO_FAR_APART');
  need(lowest >= BigInt(p.confirmations-1),'RPC_INSUFFICIENT_CONFIRMATIONS');
  const blockNumber = lowest-BigInt(p.confirmations-1);
  const blocks = (await Promise.all(captured.map(r => r.send('eth_getBlockByNumber',[hex(blockNumber),false])))).map(parseBlock);
  const first = blocks[0];
  need(blocks.every(b => b.number === blockNumber && b.hash === first.hash && b.timestampMs === first.timestampMs),'RPC_ANCHOR_DISAGREEMENT');
  const checkedAt = now(); integer(checkedAt,start,Number.MAX_SAFE_INTEGER-p.ttlMs,'CLOCK_MOVED_BACKWARDS'); signal?.throwIfAborted();
  need([...heads,first].every(b => b.timestampMs <= checkedAt+2000 && checkedAt-b.timestampMs < p.maxAgeMs),'RPC_BLOCK_STALE_OR_FUTURE');
  const anchor = {chainId,number:blockNumber,hash:first.hash,timestampMs:first.timestampMs,observedAt:checkedAt,
    expiresAt:Math.min(checkedAt+p.ttlMs,first.timestampMs+p.maxAgeMs),confirmations:p.confirmations};
  const session = new PinnedReadSession(CONSTRUCT,{readers:captured,chain,now,signal,start:checkedAt,policy:p,anchor});
  await session.verifyCurrent(); return session;
}
