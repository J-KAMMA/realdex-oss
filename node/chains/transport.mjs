import {check,object,safeEndpoint,safeError} from './core.mjs';
const RPC={
 evm:['eth_chainId','eth_getBlockByNumber'], solana:['getGenesisHash','getSlot','getBlock'],
 cosmos:['status','block'], near:['status','block'], bitcoin:['getblockchaininfo','getblockhash','getblockheader'],
 xrpl:['server_info','ledger'], substrate:['chain_getBlockHash','chain_getFinalizedHead','chain_getHeader'],
 starknet:['starknet_chainId','starknet_getBlockWithTxHashes']
};
const GET={
 tron:/^\/walletsolidity\/getnowblock$/,
 aptos:/^(?:|\/blocks\/by_height\/\d+)$/,stellar:/^(?:|\/|\/ledgers\/\d+)$/,
 algorand:/^\/(?:versions|v2\/status|v2\/blocks\/\d+\/hash|v2\/blocks\/\d+)$/,
 tezos:/^\/chains\/main\/(?:chain_id|blocks\/(?:head|\d+)\/(?:header|hash))$/,
 ton:/^\/(?:getMasterchainInfo|lookupBlock|getBlockHeader)$/
};
const POST={tron:/^\/walletsolidity\/(?:getnowblock|getblockbynum)$/};
export const SUI_HEAD_QUERY='{ chainIdentifier checkpoint { sequenceNumber digest timestamp } }';
export const SUI_BLOCK_QUERY='query Checkpoint($height: UInt53!) { checkpoint(sequenceNumber: $height) { sequenceNumber digest timestamp } }';
function rejectUnsafeNumbers(value,depth=0) {
 check(depth<=64,'JSON_DEPTH_LIMIT');
 if(typeof value==='number') check(Number.isFinite(value) && (!Number.isInteger(value)||Number.isSafeInteger(value)),'INTEGER_PRECISION_INVALID');
 else if(value&&typeof value==='object')for(const v of Object.values(value))rejectUnsafeNumbers(v,depth+1);
}
async function boundedJson(response,maxBytes,signal) {
 check(response.ok,'HTTP_REJECTED');check(/application\/(?:json|hal\+json|graphql-response\+json)(?:\s*;|$)/i.test(response.headers.get('content-type')??''),'JSON_CONTENT_TYPE_REQUIRED');
 const declared=response.headers.get('content-length');check(declared===null || /^\d{1,10}$/.test(declared)&&Number(declared)<=maxBytes,'RESPONSE_SIZE_LIMIT');
 check(response.body?.getReader,'STREAMING_RESPONSE_REQUIRED');const reader=response.body.getReader(),chunks=[];let length=0;
 try{for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;length+=value.length;check(length<=maxBytes,'RESPONSE_SIZE_LIMIT');chunks.push(value);}}
 catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 signal.throwIfAborted();const raw=new Uint8Array(length);let offset=0;for(const c of chunks){raw.set(c,offset);offset+=c.length;}
 let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new Error('JSON_INVALID');}
 rejectUnsafeNumbers(data);return data;
}
/** Fixed read-only allowlists. The endpoint and API headers MUST be supplied by
 * the local user. Peer metadata must never be fed to this constructor. */
export function createTransport(family,endpoint,{fetchImpl=globalThis.fetch,signal,timeoutMs=8000,maxBytes=2097152,headers={}}={}) {
 check(RPC[family]||GET[family]||POST[family]||family==='sui','FAMILY_UNSUPPORTED');const base=safeEndpoint(endpoint);
 check(Number.isSafeInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=30000,'TIMEOUT_INVALID');
 check(Number.isSafeInteger(maxBytes)&&maxBytes>=1024&&maxBytes<=8388608,'RESPONSE_SIZE_INVALID');
 object(headers);const h={accept:'application/json'};
 for(const [k,v]of Object.entries(headers)){
  check(['authorization','x-api-key','x-algo-api-token','tron-pro-api-key'].includes(k.toLowerCase())&&typeof v==='string'&&v.length<=2048&&!/[\r\n\x00]/.test(v),'API_HEADER_INVALID');h[k]=v;
 }
 let seq=0,active=0;
 async function request(method,path='',payload,query={}) {
  check(active<4,'RPC_CONCURRENCY_LIMIT');active++;
  try{
   const url=new URL(base);if(path)url.pathname=base.pathname.replace(/\/$/,'')+path;
   for(const [k,v]of Object.entries(query)){check(/^[a-z_]+$/.test(k)&&['string','number'].includes(typeof v),'QUERY_INVALID');url.searchParams.set(k,String(v));}
   const joined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);joined.throwIfAborted();
   const body=payload===undefined?undefined:JSON.stringify(payload);check(body===undefined||body.length<=16384,'REQUEST_SIZE_LIMIT');
   const res=await fetchImpl(url.href,{method,headers:{...h,...(body?{'content-type':'application/json'}:{})},body,
    signal:joined,credentials:'omit',redirect:'error',cache:'no-store'});
   return await boundedJson(res,maxBytes,joined);
  } catch(e){throw new Error(safeError(e));}finally{active--;}
 }
 return Object.freeze({family,origin:base.origin,
  async rpc(method,params=[]) {
   check(RPC[family]?.includes(method),'READ_METHOD_FORBIDDEN');check(Array.isArray(params)||params&&Object.getPrototypeOf(params)===Object.prototype,'PARAMS_INVALID');
   const id=++seq;const result=await request('POST','',{jsonrpc:'2.0',id,method,params});object(result,'RPC_ENVELOPE_INVALID');
   if(family==='xrpl'){
    check(result.id===undefined||result.id===id,'RPC_RESPONSE_ID_MISMATCH');object(result.result,'RPC_ENVELOPE_INVALID');
    check(result.result.status==='success'&&!Object.hasOwn(result.result,'error'),'RPC_REMOTE_ERROR');return result.result;
   }
   check(result.id===id,'RPC_RESPONSE_ID_MISMATCH');check(result.jsonrpc==='2.0'||family==='bitcoin'&&result.jsonrpc===undefined,'RPC_PROTOCOL_INVALID');
   check(result.error===undefined||family==='bitcoin'&&result.error===null,'RPC_REMOTE_ERROR');check(Object.hasOwn(result,'result'),'RPC_RESULT_MISSING');return result.result;
  },
  async get(path='',query={}){
   check(GET[family]?.test(path),'READ_PATH_FORBIDDEN');
   const allowed=family==='aptos'?['with_transactions']:family==='algorand'?['format']:family==='ton'?['workchain','shard','seqno','root_hash','file_hash']:[];
   check(Object.keys(query).every(k=>allowed.includes(k)),'QUERY_FORBIDDEN');return request('GET',path,undefined,query);
  },
  async post(path,payload){check(POST[family]?.test(path),'READ_PATH_FORBIDDEN');return request('POST',path,payload);},
  async graphql(query,variables={}){
   check(family==='sui' && [SUI_HEAD_QUERY,SUI_BLOCK_QUERY].includes(query),'READ_QUERY_FORBIDDEN');
   const r=await request('POST','',{query,variables});object(r,'GRAPHQL_RESPONSE_INVALID');
   check(!r.errors&&r.data,'GRAPHQL_REMOTE_ERROR');return object(r.data,'GRAPHQL_RESPONSE_INVALID');
  }
 });
}
