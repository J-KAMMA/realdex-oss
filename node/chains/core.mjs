// Dependency-free, browser/Node shared validation. No wallet capabilities.
export function check(ok, code) { if (!ok) throw new Error(code); }
export function object(x, code='OBJECT_REQUIRED') {
  check(x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype, code); return x;
}
export function text(x, max=128) {
  check(typeof x === 'string' && x.length > 0 && x.length <= max && !/[\x00-\x1f\x7f]/.test(x), 'TEXT_INVALID'); return x;
}
export function uint(x, max=(1n<<256n)-1n) {
  if (typeof x === 'number') check(Number.isSafeInteger(x) && x >= 0, 'INTEGER_PRECISION_INVALID');
  check((typeof x === 'string' || typeof x === 'number' || typeof x === 'bigint') && /^(0|[1-9][0-9]{0,77})$/.test(String(x)), 'UINT_INVALID');
  const n=BigInt(x); check(n<=max,'UINT_RANGE'); return n;
}
export function hexUint(x) {
  check(typeof x==='string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(x),'HEX_UINT_INVALID'); return BigInt(x);
}
export const toHex = x => '0x'+uint(x).toString(16);
export function safeNumber(x) { const n=uint(x);check(n<=BigInt(Number.MAX_SAFE_INTEGER),'INTEGER_PRECISION_INVALID'); return Number(n); }
export function hashHex(x,prefix=true) {
  check(typeof x==='string' && (prefix?/^0x[0-9a-fA-F]{64}$/:/^[0-9a-fA-F]{64}$/).test(x),'HASH_INVALID'); return x.toLowerCase();
}
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Bytes(s,size=32) {
  text(s,100); let n=0n; for(const c of s){const v=B58.indexOf(c);check(v>=0,'BASE58_INVALID');n=n*58n+BigInt(v);}
  let tail=[];while(n){tail.unshift(Number(n&255n));n>>=8n;}
  let zeros=0;while(s[zeros]==='1')zeros++;
  const result=new Uint8Array([...Array(zeros).fill(0),...tail]);check(result.length===size,'HASH_INVALID');return result;
}
export function hash58(s){base58Bytes(s);return s;}
export function hash64(s){check(typeof s==='string' && /^[A-Za-z0-9+/]{43}=$/.test(s),'HASH_INVALID');
  const b=Uint8Array.from(atob(s),c=>c.charCodeAt(0));check(b.length===32 && btoa(String.fromCharCode(...b))===s,'HASH_INVALID');return s;}
// A 32-byte base32 digest has 52 characters; its last four bits are padding.
export function hash32(s){check(typeof s==='string' && /^[A-Z2-7]{51}[AQ]$/.test(s),'HASH_INVALID');return s;}
export function millis(x,unit='ms') {
  const n=uint(x); const m=unit==='seconds'?n*1000n:unit==='ns'?n/1000000n:unit==='us'?n/1000n:n;
  check(m>0n && m<=BigInt(Number.MAX_SAFE_INTEGER),'TIME_INVALID');return Number(m);
}
export function isoMillis(x) {
  check(typeof x==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(x),'TIME_INVALID');
  const n=Date.parse(x);check(Number.isSafeInteger(n)&&n>0,'TIME_INVALID');return n;
}
export function freeze(value) {
  if(value && typeof value==='object' && !Object.isFrozen(value)){Object.freeze(value); for(const x of Object.values(value))freeze(x);}return value;
}
export function canonical(x) {
  if(x===null||typeof x==='boolean'||typeof x==='string')return JSON.stringify(x);
  if(typeof x==='number'){check(Number.isSafeInteger(x),'INTEGER_PRECISION_INVALID');return String(x);}
  if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';object(x);return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
}
export function safeEndpoint(raw) {
  check(typeof raw==='string' && raw.length<=2048 && !/[\x00-\x20\x7f\\]/.test(raw),'ENDPOINT_INVALID');
  let u;try{u=new URL(raw);}catch{throw new Error('ENDPOINT_INVALID');}
  check(!u.username&&!u.password&&!u.hash && (u.protocol==='https:' || (u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))),'ENDPOINT_UNSAFE');
  return u;
}
export function safeError(e){return e instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:e?.name==='AbortError'?'OPERATION_ABORTED':e?.name==='TimeoutError'?'REQUEST_TIMEOUT':'REQUEST_FAILED';}
