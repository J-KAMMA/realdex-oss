import {check,guardedEndpoint,validateHeaders,extensionError,boundedSignal} from './guard.mjs';
import {parseExactJson} from './json.mjs';
/** Await even a custom fetch/ReadableStream with an explicit cancellation bound. */
async function abortable(promise,signal){signal.throwIfAborted();let onAbort;
 const stopped=new Promise((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});});
 try{return await Promise.race([promise,stopped]);}finally{signal.removeEventListener('abort',onAbort);}}
export async function readBytes(response,{signal,maxBytes=2097152,contentTypes=['application/json']}={}){
 check(response.ok,'HTTP_REJECTED');const type=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();check(contentTypes.includes(type),'CONTENT_TYPE_INVALID');
 const declared=response.headers.get('content-length');check(declared===null||/^\d{1,10}$/.test(declared)&&Number(declared)<=maxBytes,'RESPONSE_SIZE_LIMIT');
 check(response.body?.getReader,'STREAMING_RESPONSE_REQUIRED');const reader=response.body.getReader(),parts=[];let length=0;
 try{for(;;){const {done,value}=await abortable(reader.read(),signal);if(done)break;length+=value.byteLength;check(length<=maxBytes,'RESPONSE_SIZE_LIMIT');parts.push(value);}}
 catch(e){reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 signal.throwIfAborted();const bytes=new Uint8Array(length);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.byteLength;}return bytes;
}
/** Internal transport primitive. Only fixed-schema read adapters import this.
 * No external data is used to select an endpoint, redirect or DNS fallback. */
export function readHttp(endpoint,{access={},headers={},fetchImpl=globalThis.fetch,signal,timeoutMs=8000,maxBytes=2097152}={}){
 const base=guardedEndpoint(endpoint,access),auth=validateHeaders(headers);
 check(typeof fetchImpl==='function','FETCH_REQUIRED');check(Number.isSafeInteger(maxBytes)&&maxBytes>=1024&&maxBytes<=8388608,'RESPONSE_SIZE_INVALID');
 check(Number.isSafeInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=30000,'TIMEOUT_INVALID');let active=0;
 return async function request({path='',method='POST',json,bytes,contentType='application/json',responseType='json'}){
  check(active<4,'RPC_CONCURRENCY_LIMIT');active++;
  try{check(['GET','POST'].includes(method)&&['json','cbor'].includes(responseType),'REQUEST_INVALID');
   check(path===''||/^\/[A-Za-z0-9_/-]+$/.test(path),'PATH_INVALID');const u=new URL(base);if(path)u.pathname=base.pathname.replace(/\/$/,'')+path;
   check(u.origin===base.origin,'ORIGIN_CHANGED');const joined=boundedSignal(signal,timeoutMs);joined.throwIfAborted();
   const body=bytes??(json===undefined?undefined:JSON.stringify(json));check(body===undefined||typeof body==='string'&&body.length<=16384||body instanceof Uint8Array&&body.byteLength<=16384,'REQUEST_SIZE_LIMIT');
   const response=await abortable(Promise.resolve().then(()=>fetchImpl(u.href,{method,headers:{accept:responseType==='cbor'?'application/cbor':'application/json',...auth,...(body?{'content-type':contentType}:{})},body,signal:joined,credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'})),joined);
   check(!response.redirected,'REDIRECT_FORBIDDEN');const raw=await readBytes(response,{signal:joined,maxBytes,contentTypes:[responseType==='cbor'?'application/cbor':'application/json']});
   if(responseType==='cbor')return raw;
   let s;try{s=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{throw Error('JSON_INVALID');}return parseExactJson(s,{maxChars:maxBytes});
  }catch(e){throw Error(extensionError(e));}finally{active--;}
 };
}
