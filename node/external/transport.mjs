import {guardedEndpoint,boundedSignal} from '../extended/guard.mjs';
import {readBytes} from '../extended/http.mjs';
import {parseExactJson} from '../extended/json.mjs';
import {need} from './math.mjs';
/** This transport exposes only fixed, public read calls. No headers/credentials from a wallet. */
export function transport(endpoint,{access={},fetchImpl=globalThis.fetch,signal,timeoutMs=8000}={}) {
 const base=guardedEndpoint(endpoint,access);need(base.pathname==='/'&&!base.search,'SPOT_ENDPOINT_ROOT');
 need(typeof fetchImpl==='function'&&Number.isInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=30000,'SPOT_TRANSPORT');let active=0;
 return async function request(kind,payload){
  const grpc=kind==='Market'||kind==='OrderbookV2';
  need(grpc||kind==='spotMeta'||kind==='l2Book','SPOT_READ_ONLY_METHOD');need(active<2,'SPOT_CONCURRENCY');active++;
  const joined=boundedSignal(signal,timeoutMs);let onAbort;
  const stop=new Promise((_,reject)=>{onAbort=()=>reject(Error('SPOT_ABORTED'));joined.addEventListener('abort',onAbort,{once:true});});
  try {joined.throwIfAborted();const u=new URL(grpc?`/injective_spot_exchange_rpc.InjectiveSpotExchangeRPC/${kind}`:'/info',base);
   const body=grpc?payload:JSON.stringify(kind==='l2Book'?{type:kind,coin:payload}:{type:kind});need(grpc?body instanceof Uint8Array&&body.length<=4096:body.length<=4096,'SPOT_REQUEST');
   const response=await Promise.race([Promise.resolve().then(()=>fetchImpl(u.href,{method:'POST',body,headers:{accept:grpc?'application/grpc-web+proto':'application/json','content-type':grpc?'application/grpc-web+proto':'application/json',...(grpc?{'x-grpc-web':'1'}:{})},credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:joined})),stop]);
   need(!response.redirected,'SPOT_REDIRECT');const bytes=await readBytes(response,{signal:joined,maxBytes:2097152,contentTypes:grpc?['application/grpc-web+proto','application/grpc-web']:['application/json']});
   if(grpc)return {bytes,status:response.headers.get('grpc-status')};
   let s;try{s=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('SPOT_JSON');}return parseExactJson(s,{maxChars:2097152});
  }catch(e){throw Error(e instanceof Error&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:joined.aborted?'SPOT_ABORTED':'SPOT_TRANSPORT_FAILED');}
  finally{active--;joined.removeEventListener('abort',onAbort);}
 };
}
