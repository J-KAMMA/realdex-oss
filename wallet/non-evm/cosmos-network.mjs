/** Local-only Cosmos SDK / CometBFT transport. RPC agreement is not a light client. */
import {need, shape, text, uint, freeze, canonical} from '../lib/guard.mjs';
import {parseExactJson} from '../../node/extended/json.mjs';
import {fingerprint} from './solana-codec.mjs';

export const COSMOS_ASSURANCE = 'RPC observation; no independent consensus or application-state proof';
export const COSMOS_ONLINE_OPERATION = 'cosmos-bank-send-online';
export const U64 = (1n << 64n) - 1n;
export function cosmosInt(v, max = Number.MAX_SAFE_INTEGER) {
  need((typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v)) || (Number.isSafeInteger(v) && v >= 0), 'COSMOS_RPC_INTEGER_INVALID');
  need(BigInt(v) <= BigInt(max), 'COSMOS_RPC_INTEGER_RANGE');
  return Number(v);
}
export function cosmosHash(v) {
  need(typeof v === 'string' && /^[0-9A-Fa-f]{64}$/.test(v) && !/^0+$/.test(v), 'COSMOS_HASH_INVALID');
  return v.toUpperCase();
}
export function cosmosDenom(v) {
  need(typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9]{2,63}$/.test(v), 'COSMOS_NATIVE_DENOM_REQUIRED');
  return v;
}
function localUrl(s) {
  text(s, 200);
  let u; try { u = new URL(s); } catch { throw Error('COSMOS_RPC_URL_INVALID'); }
  need(u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password, 'COSMOS_LOOPBACK_RPC_REQUIRED');
  return u.href;
}
export function validateCosmosNetwork(n) {
  shape(n, ['family','id','name','chainId','hrp','endpoints','checkpoint','denom','decimals','symbol','feeDenom','feeDecimals','maxTransferAtomic','maxFeeAtomic','maxGasLimit','timeoutBlocks','minConfirmations','broadcastEnabled']);
  need(n.family === 'cosmos' && typeof n.chainId === 'string' && /^realdex-local-[a-z0-9-]{1,32}$/.test(n.chainId) && n.id === 'cosmos:' + n.chainId, 'COSMOS_LOCAL_CHAIN_ID_REQUIRED');
  text(n.name, 100); text(n.symbol, 16);
  need(typeof n.hrp === 'string' && /^[a-z][a-z0-9]{1,15}$/.test(n.hrp), 'COSMOS_PREFIX_INVALID');
  cosmosDenom(n.denom); cosmosDenom(n.feeDenom);
  const decimals = cosmosInt(n.decimals, 18), feeDecimals = cosmosInt(n.feeDecimals, 18);
  need(n.denom !== n.feeDenom || decimals === feeDecimals, 'COSMOS_DECIMALS_CONFLICT');
  need(Array.isArray(n.endpoints) && n.endpoints.length >= 2 && n.endpoints.length <= 4, 'COSMOS_TWO_TO_FOUR_ENDPOINTS_REQUIRED');
  const endpoints = n.endpoints.map(e => { shape(e, ['rpcUrl','restUrl']); return {rpcUrl:localUrl(e.rpcUrl), restUrl:localUrl(e.restUrl)}; });
  for (const key of ['rpcUrl','restUrl']) need(new Set(endpoints.map(e => e[key])).size === endpoints.length, 'COSMOS_DUPLICATE_ENDPOINT');
  shape(n.checkpoint, ['height','hash']); const height = cosmosInt(n.checkpoint.height, 2147483647);
  need(height > 0, 'COSMOS_CHECKPOINT_REQUIRED');
  const maxTransferAtomic = String(uint(n.maxTransferAtomic)), maxFeeAtomic = String(uint(n.maxFeeAtomic, 1000000000000n));
  const maxGasLimit = String(uint(n.maxGasLimit, 10000000n));
  const timeoutBlocks = cosmosInt(n.timeoutBlocks, 100), minConfirmations = cosmosInt(n.minConfirmations, 100);
  need(BigInt(maxTransferAtomic) > 0n && BigInt(maxFeeAtomic) > 0n && BigInt(maxGasLimit) > 0n && timeoutBlocks >= 2 && minConfirmations >= 1, 'COSMOS_POLICY_INVALID');
  need(typeof n.broadcastEnabled === 'boolean', 'BROADCAST_FLAG_INVALID');
  return freeze({...n, endpoints, decimals, feeDecimals, maxTransferAtomic, maxFeeAtomic, maxGasLimit, timeoutBlocks, minConfirmations, checkpoint:{height,hash:cosmosHash(n.checkpoint.hash)}});
}
export const cosmosNetworkFingerprint = n => fingerprint(validateCosmosNetwork(n));

export class CosmosRpc {
  constructor({fetchImpl = globalThis.fetch, timeoutMs = 10000} = {}) { this.fetchImpl=fetchImpl; this.timeoutMs=timeoutMs; }
  async request(url, {method='GET', body, height} = {}) {
    let response;
    try {
      response = await this.fetchImpl(url, {method, headers:{accept:'application/json', ...(body===undefined?{}:{'content-type':'application/json'}), ...(height===undefined?{}:{'x-cosmos-block-height':String(height)})}, ...(body===undefined?{}:{body:JSON.stringify(body)}), credentials:'omit', redirect:'error', signal:AbortSignal.timeout(this.timeoutMs)});
    } catch { throw Error('COSMOS_RPC_TRANSPORT_UNCERTAIN'); }
    const reader=response.body?.getReader(); need(reader, 'COSMOS_RPC_EMPTY_RESPONSE'); let size=0; const chunks=[];
    try {
      for (;;) { const {value,done}=await reader.read(); if(done)break; size+=value.length; need(size<=1048576, 'COSMOS_RPC_RESPONSE_LIMIT'); chunks.push(Buffer.from(value)); }
    } catch(e) { if(e.message==='COSMOS_RPC_RESPONSE_LIMIT')throw e; throw Error('COSMOS_RPC_TRANSPORT_UNCERTAIN'); }
    finally { await reader.cancel().catch(()=>{}); }
    need(response.ok, 'COSMOS_RPC_HTTP_ERROR');
    need(response.headers.get('content-type')?.includes('json'), 'COSMOS_RPC_CONTENT_TYPE');
    let data; try { data=parseExactJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),{maxChars:1048576,maxNodes:20000,maxDepth:32}); } catch { throw Error('COSMOS_RPC_JSON_INVALID'); }
    // Height metadata must be honored by state queries; no silent latest fallback.
    if(height!==undefined) need(response.headers.get('x-cosmos-block-height')===String(height), 'COSMOS_QUERY_HEIGHT_MISMATCH');
    return data;
  }
  endpoint(network, index) {
    const n=validateCosmosNetwork(network); need(Number.isInteger(index)&&index>=0&&index<n.endpoints.length, 'COSMOS_RPC_INDEX'); return n.endpoints[index];
  }
  async comet(n, index, method, params={}) {
    const e=this.endpoint(n,index);
    if(method==='status')shape(params,[]);
    else if(method==='block') { shape(params,['height']); need(cosmosInt(params.height)>0, 'COSMOS_HEIGHT_INVALID'); }
    else if(method==='tx') { shape(params,['hash','prove']); need(params.prove===true, 'COSMOS_PROOF_REQUIRED'); const b=Buffer.from(params.hash,'base64'); need(b.length===32&&b.toString('base64')===params.hash, 'COSMOS_TX_HASH_INVALID'); }
    else throw Error('COSMOS_RPC_METHOD_FORBIDDEN');
    const v=await this.request(e.rpcUrl,{method:'POST',body:{jsonrpc:'2.0',id:1,method,params}});
    need(v?.jsonrpc==='2.0'&&v.id==='1'&&v.result!==undefined&&v.error===undefined, 'COSMOS_COMET_RPC_ERROR');
    return v.result;
  }
  async rest(n, index, endpoint, {body, height}={}) {
    const e=this.endpoint(n,index);
    need(typeof endpoint==='string'&&!endpoint.includes('..')&&!endpoint.includes('://')&&!endpoint.startsWith('/')&&!endpoint.includes('#'), 'COSMOS_RPC_PATH_FORBIDDEN');
    const u=new URL(endpoint,e.restUrl), path=u.pathname;
    const grants=path==='/cosmos/authz/v1beta1/grants';
    const account=/^\/cosmos\/auth\/v1beta1\/accounts\/[a-z0-9]{3,90}$/.test(path);
    const balance=/^\/cosmos\/bank\/v1beta1\/spendable_balances\/[a-z0-9]{3,90}\/by_denom$/.test(path);
    if(body===undefined) {
      need(account||balance||grants, 'COSMOS_RPC_METHOD_FORBIDDEN'); need(cosmosInt(height)>0, 'COSMOS_QUERY_HEIGHT_REQUIRED');
      if(grants){const keys=[...u.searchParams.keys()];need(keys.length===2&&new Set(keys).size===2&&keys.every(k=>['granter','grantee'].includes(k))&&['granter','grantee'].every(k=>/^[a-z0-9]{3,90}$/.test(u.searchParams.get(k))),'COSMOS_RPC_QUERY_FORBIDDEN');}
      if(account)need(!u.search, 'COSMOS_RPC_QUERY_FORBIDDEN');
      if(balance){need([...u.searchParams.keys()].length===1&&u.searchParams.has('denom'), 'COSMOS_RPC_QUERY_FORBIDDEN');cosmosDenom(u.searchParams.get('denom'));}
    } else {
      need(!u.search&&['/cosmos/tx/v1beta1/simulate','/cosmos/tx/v1beta1/txs'].includes(path), 'COSMOS_RPC_METHOD_FORBIDDEN');
      shape(body,path.endsWith('/txs')?['tx_bytes','mode']:['tx_bytes']);
      need(typeof body.tx_bytes==='string'&&body.tx_bytes.length>0&&body.tx_bytes.length<=21848&&Buffer.from(body.tx_bytes,'base64').toString('base64')===body.tx_bytes, 'COSMOS_TX_BYTES_INVALID');
      if(path.endsWith('/simulate'))need(cosmosInt(height)>0,'COSMOS_QUERY_HEIGHT_REQUIRED');
      if(path.endsWith('/txs'))need(body.mode==='BROADCAST_MODE_SYNC'&&height===undefined, 'COSMOS_BROADCAST_MODE_INVALID');
    }
    return this.request(u.href,{method:body===undefined?'GET':'POST',body,height});
  }
  async agree(n, fn, project=x=>x) {
    const results=(await Promise.all(n.endpoints.map((_,i)=>fn(i)))).map(project);
    need(results.every(v=>canonical(v)===canonical(results[0])), 'COSMOS_RPC_DISAGREEMENT'); return results[0];
  }
}
