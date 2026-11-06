/** Privacy extension boundaries. These are application policy checks, not anonymity proofs. */
import {check,object,freeze,safeEndpoint,text,uint} from '../chains/core.mjs';
export {check,object,freeze,text,uint};
export function keys(value,required,optional=[]){
 object(value,'SCHEMA_INVALID');const all=[...required,...optional];
 check(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>all.includes(k)),'SCHEMA_INVALID');return value;
}
export function accessPolicy(raw={}){
 keys(raw,[],['mode','allowedOrigins']);const mode=raw.mode??'local-only';
 check(['local-only','explicit-remote'].includes(mode),'ACCESS_POLICY_INVALID');
 const origins=raw.allowedOrigins??[];check(Array.isArray(origins)&&origins.length<=4,'ACCESS_POLICY_INVALID');
 const allowedOrigins=origins.map(s=>{const u=safeEndpoint(s);check(u.protocol==='https:'&&u.origin===s,'REMOTE_ORIGIN_INVALID');return s;});
 check(new Set(allowedOrigins).size===allowedOrigins.length,'REMOTE_ORIGIN_DUPLICATE');
 check(mode==='local-only'?allowedOrigins.length===0:allowedOrigins.length>0,'ACCESS_POLICY_INVALID');
 return freeze({mode,allowedOrigins});
}
export function guardedEndpoint(endpoint,access={}){
 const policy=accessPolicy(access),u=safeEndpoint(endpoint);
 // Literal loopback only: do not rely on an externally configured localhost resolver.
 const loopback=['127.0.0.1','[::1]'].includes(u.hostname);
 check(loopback||(policy.mode==='explicit-remote'&&u.protocol==='https:'&&policy.allowedOrigins.includes(u.origin)),'REMOTE_DISCLOSURE_NOT_AUTHORIZED');
 return u;
}
export function endpointConfigs(endpoints,access={}){
 check(Array.isArray(endpoints)&&endpoints.length>=1&&endpoints.length<=4,'ONE_TO_FOUR_ENDPOINTS_REQUIRED');
 const policy=accessPolicy(access),out=endpoints.map(e=>typeof e==='string'?{url:e}:structuredClone(keys(e,['url'],['headers'])));
 for(const e of out){guardedEndpoint(e.url,policy);if(e.headers!==undefined)validateHeaders(e.headers);}
 check(new Set(out.map(e=>new URL(e.url).origin)).size===out.length,'DISTINCT_RPC_ORIGINS_REQUIRED');return out;
}
export function validateHeaders(raw={}){
 object(raw,'HEADERS_INVALID');check(Object.keys(raw).length<=2,'HEADERS_INVALID');const out={};
 for(const [name,value] of Object.entries(raw)){
  const key=name.toLowerCase();check(['authorization','x-api-key'].includes(key)&&!Object.hasOwn(out,key),'HEADERS_INVALID');
  check(typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\x00-\x1f\x7f]/.test(value),'HEADERS_INVALID');out[key]=value;
 }
 return out;
}
export function extensionError(e){return e instanceof Error&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:
 e?.name==='AbortError'?'OPERATION_ABORTED':e?.name==='TimeoutError'?'REQUEST_TIMEOUT':'REQUEST_FAILED';}
export function makeClock(now=Date.now,signal,ttlMs=30000){
 check(typeof now==='function'&&Number.isSafeInteger(ttlMs)&&ttlMs>0&&ttlMs<=60000,'CLOCK_POLICY_INVALID');let last=0;
 return ()=>{signal?.throwIfAborted();const n=now();check(Number.isSafeInteger(n)&&n>0&&n<=Number.MAX_SAFE_INTEGER-ttlMs,'CLOCK_INVALID');check(n>=last,'CLOCK_MOVED_BACKWARDS');last=n;return n;};
}
export function boundedSignal(signal,timeoutMs=30000){check(Number.isSafeInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=120000,'TIMEOUT_INVALID');
 return signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);}
