/**
 * Owner-configured loopback networks only. Agreement is not a consensus proof.
 * Deliberately supports only Stellar Standalone and Aptos chain ID 4.
 */
import {need,shape,text,uint,freeze,canonical} from '../lib/guard.mjs';
import {parseExactJson} from '../../node/extended/json.mjs';
import {fingerprint} from './solana-codec.mjs';
import {STELLAR_LOCAL_PASSPHRASE} from './stellar-offline.mjs';
export const ACCOUNT_ASSURANCE='RPC observation only; no consensus/finality proof';
export const onlineOperation=f=>f==='stellar'?'stellar-native-payment-online':'aptos-native-transfer-online';
export const int=(v,max=Number.MAX_SAFE_INTEGER)=>{
  need((typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v))||(Number.isSafeInteger(v)&&v>=0),'ACCOUNT_RPC_INTEGER_INVALID');
  const n=BigInt(v);need(n<=BigInt(max),'ACCOUNT_RPC_INTEGER_RANGE');return Number(n);
};
export const hash=(v,aptos=false)=>{
  need(typeof v==='string'&&(aptos?/^0x[0-9a-f]{64}$/:/^[0-9a-f]{64}$/).test(v)&&!/^0x?0+$/.test(v)&&v!== '0'.repeat(64),'ACCOUNT_HASH_INVALID');return v;
};
export function decimalAtomic(value,decimals){
  need(typeof value==='string'&&value.length<=80&&/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value),'ACCOUNT_AMOUNT_PRECISION');
  const [w,f='']=value.split('.');need(f.length<=decimals,'ACCOUNT_AMOUNT_PRECISION');
  return String(BigInt(w)*10n**BigInt(decimals)+BigInt(f.padEnd(decimals,'0')||'0'));
}
export function validateAccountNetwork(n){
  shape(n,['family','id','name','rpcUrls','checkpoint','broadcastEnabled','maxTransferAtomic','maxFeeAtomic','minConfirmations'],['networkPassphrase','chainId']);
  const stellar=n.family==='stellar';need(stellar||n.family==='aptos','ACCOUNT_FAMILY_UNSUPPORTED');
  need(n.id===(stellar?'stellar:standalone':'aptos:local-4'),'ACCOUNT_LOCAL_NETWORK_ONLY');text(n.name,100);
  if(stellar)need(n.networkPassphrase===STELLAR_LOCAL_PASSPHRASE&&n.chainId===undefined,'STELLAR_STANDALONE_ONLY');
  else need(n.chainId===4&&n.networkPassphrase===undefined,'APTOS_LOCAL_CHAIN_FOUR_ONLY');
  shape(n.checkpoint,['height','hash']);const height=int(n.checkpoint.height,2147483647);need(height>=1,'ACCOUNT_CHECKPOINT_REQUIRED');hash(n.checkpoint.hash,!stellar);
  need(Array.isArray(n.rpcUrls)&&n.rpcUrls.length>=2&&n.rpcUrls.length<=4,'ACCOUNT_TWO_TO_FOUR_RPC_REQUIRED');
  const rpcUrls=n.rpcUrls.map(s=>{
    text(s,256);let u;try{u=new URL(s);}catch{throw Error('ACCOUNT_RPC_URL_INVALID');}
    need(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname===(stellar?'/':'/v1/'),'ACCOUNT_LOOPBACK_RPC_REQUIRED');
    return u.href;
  });
  need(new Set(rpcUrls).size===rpcUrls.length,'ACCOUNT_DUPLICATE_RPC');
  need(typeof n.broadcastEnabled==='boolean','BROADCAST_FLAG_INVALID');
  const maxTransferAtomic=String(uint(n.maxTransferAtomic,stellar?(1n<<63n)-1n:(1n<<64n)-1n));
  const maxFeeAtomic=String(uint(n.maxFeeAtomic,10000000000n));
  need(BigInt(maxTransferAtomic)>0n&&BigInt(maxFeeAtomic)>0n,'ACCOUNT_CAP_INVALID');
  const minConfirmations=int(n.minConfirmations,100);need(minConfirmations>=1,'ACCOUNT_CONFIRMATION_POLICY_INVALID');
  return freeze({family:n.family,id:n.id,name:n.name,rpcUrls,checkpoint:{height,hash:n.checkpoint.hash},broadcastEnabled:n.broadcastEnabled,maxTransferAtomic,maxFeeAtomic,minConfirmations,...(stellar?{networkPassphrase:n.networkPassphrase}:{chainId:4})});
}
export const accountNetworkFingerprint=n=>fingerprint(validateAccountNetwork(n));
/** Exact path/query contract. No optional query is forwarded to a signer or node. */
export function accountRequestTarget(network, endpoint, method, notFound = false) {
  need(typeof endpoint === 'string' && endpoint.length <= 512 &&
    /^[A-Za-z0-9_/?=&-]*$/.test(endpoint) && !endpoint.startsWith('/') &&
    !endpoint.includes('..'), 'ACCOUNT_RPC_PATH_FORBIDDEN');
  const parts = endpoint.split('?');
  need(parts.length <= 2 && (parts.length === 1 || parts[1].length > 0), 'ACCOUNT_RPC_QUERY_FORBIDDEN');
  const path = parts[0], query = new URLSearchParams(parts[1] ?? '');
  const pairs = [...query];
  need(new Set(pairs.map(([k]) => k)).size === pairs.length, 'ACCOUNT_RPC_QUERY_FORBIDDEN');
  const exactQuery = expected => {
    need(pairs.length === Object.keys(expected).length && Object.entries(expected).every(([k, v]) =>
      query.get(k) === v), 'ACCOUNT_RPC_QUERY_FORBIDDEN');
  };
  let requestedVersion;
  const historical = () => {
    need(pairs.length === 1 && query.has('ledger_version'), 'ACCOUNT_RPC_QUERY_FORBIDDEN');
    requestedVersion = uint(query.get('ledger_version'), (1n << 64n) - 1n);
  };
  if (network.family === 'stellar') {
    if (method === 'GET' && /^(|ledgers\/[0-9]+|accounts\/G[A-Z2-7]{55}|transactions\/[0-9a-f]{64})$/.test(path)) exactQuery({});
    else if (method === 'GET' && /^transactions\/[0-9a-f]{64}\/operations$/.test(path)) exactQuery({limit:'2', include_failed:'true'});
    else if (method === 'POST' && path === 'transactions') exactQuery({});
    else throw Error('ACCOUNT_RPC_METHOD_FORBIDDEN');
  } else {
    if (method === 'GET' && /^(|transactions\/by_(hash\/0x[0-9a-f]{64}|version\/[0-9]+))$/.test(path)) exactQuery({});
    else if (method === 'GET' && /^blocks\/by_(height|version)\/[0-9]+$/.test(path)) exactQuery({with_transactions:'false'});
    else if (method === 'GET' && /^accounts\/0x[0-9a-f]{64}$/.test(path)) historical();
    else if (method === 'POST' && path === 'view') historical();
    else if (method === 'POST' && path === 'transactions/simulate') exactQuery({estimate_gas_unit_price:'false', estimate_max_gas_amount:'false'});
    else if (method === 'POST' && path === 'transactions') exactQuery({});
    else throw Error('ACCOUNT_RPC_METHOD_FORBIDDEN');
  }
  if (notFound) need(method === 'GET' && (network.family === 'stellar' ?
    /^transactions\/[0-9a-f]{64}$/ : /^transactions\/by_(hash\/0x[0-9a-f]{64}|version\/[0-9]+)$/).test(path), 'ACCOUNT_NOT_FOUND_POLICY_INVALID');
  return {endpoint, requestedVersion};
}

/** Validate JSON before native parsing: duplicate names and invalid Unicode must not collapse. */
export function parseAccountJson(bytes) {
  try {
    const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    const exact = parseExactJson(text, {maxChars:524288, maxNodes:20000, maxDepth:32});
    const parsed = JSON.parse(text);
    // Pair with the lossless parse: 1e-9999 or 1.0000000000000001 must not
    // silently become the apparently safe integers 0 or 1 in JSON.parse.
    const check = (value, original) => {
      if (typeof value === 'number') {
        need(typeof original === 'string' && /^-?(0|[1-9][0-9]*)$/.test(original) &&
          Number.isSafeInteger(value) && !Object.is(value, -0) &&
          BigInt(original) === BigInt(value), 'ACCOUNT_RPC_JSON_INVALID');
      } else if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) check(value[key], original[key]);
      }
    };
    check(parsed, exact);
    return parsed;
  } catch { throw Error('ACCOUNT_RPC_JSON_INVALID'); }
}

export class AccountRest {
  constructor({fetchImpl=globalThis.fetch, timeoutMs=10000}={}) { this.fetchImpl=fetchImpl; this.timeoutMs=timeoutMs; }
  async call(network, index, endpoint, {method='GET', body, contentType='application/json', notFound=false}={}) {
    const n = validateAccountNetwork(network);
    need(Number.isInteger(index) && index >= 0 && index < n.rpcUrls.length, 'ACCOUNT_RPC_INDEX');
    const target = accountRequestTarget(n, endpoint, method, notFound);
    let response;
    try {
      response = await this.fetchImpl(new URL(target.endpoint, n.rpcUrls[index]).href, {
        method, headers:{accept:'application/json', ...(method==='POST'?{'content-type':contentType}:{})},
        ...(body!==undefined?{body}:{}), credentials:'omit', redirect:'error', signal:AbortSignal.timeout(this.timeoutMs)
      });
    } catch { throw Error('ACCOUNT_RPC_TRANSPORT_UNCERTAIN'); }
    if (response.status === 404 && notFound) { await response.body?.cancel().catch(()=>{}); return null; }
    const reader = response.body?.getReader(); need(reader, 'ACCOUNT_RPC_EMPTY_RESPONSE');
    let size=0; const chunks=[];
    try {
      for (;;) {
        const {done,value} = await reader.read(); if(done) break;
        size += value.length; need(size <= 524288, 'ACCOUNT_RPC_RESPONSE_LIMIT'); chunks.push(Buffer.from(value));
      }
    } catch (e) { if(e.message==='ACCOUNT_RPC_RESPONSE_LIMIT') throw e; throw Error('ACCOUNT_RPC_TRANSPORT_UNCERTAIN'); }
    finally { await reader.cancel().catch(()=>{}); }
    need(response.ok, 'ACCOUNT_RPC_HTTP_ERROR');
    need(/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'ACCOUNT_RPC_CONTENT_TYPE');
    if (n.family === 'aptos') {
      need(response.headers.get('x-aptos-chain-id') === '4', 'APTOS_RPC_HEADER_CHAIN_MISMATCH');
      const version = uint(response.headers.get('x-aptos-ledger-version'), (1n<<64n)-1n);
      // This checks availability, NOT a cryptographic historical-state proof.
      if (target.requestedVersion !== undefined) {
        need(version >= target.requestedVersion, 'APTOS_RPC_HEADER_BEHIND_SNAPSHOT');
        const oldest=response.headers.get('x-aptos-ledger-oldest-version');
        if(oldest!==null) need(uint(oldest,(1n<<64n)-1n)<=target.requestedVersion, 'APTOS_RPC_SNAPSHOT_PRUNED');
      }
    }
    return parseAccountJson(Buffer.concat(chunks));
  }
  async all(n,p,o) { return Promise.all(n.rpcUrls.map((_,i)=>this.call(n,i,p,o))); }
  // `moving` says the resource being read changes as the chain advances: the latest
  // ledger, an account's current state, whether a transaction has been ingested yet.
  // Two honest readers a fraction of a second apart differ about those as a matter of
  // course, and reporting that as ACCOUNT_RPC_DISAGREEMENT made the integrity alarm
  // fire for the ordinary case, which is how an alarm stops meaning anything. A value
  // keyed to a fixed height cannot honestly differ, so that one keeps the alarm.
  // Callers must not pass moving for anything height-keyed; the default is the alarm.
  async agree(n,p,o,project=x=>x,{moving=false}={}) {
    const values=(await this.all(n,p,o)).map(project);
    need(values.every(v=>canonical(v)===canonical(values[0])), moving?'ACCOUNT_RPC_TIME_SKEW':'ACCOUNT_RPC_DISAGREEMENT'); return values[0];
  }
}
