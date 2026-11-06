/** Candid wire subset for ICRC read-only methods. Bounded decoding, no dynamic
 * type loading, no service references, no calls and no transaction serializer. */
import {check,keys} from '../extended/guard.mjs';
import {principalBytes,principalText,icrcAccount} from './principal.mjs';
export const READ_METHODS=Object.freeze(['icrc1_name','icrc1_symbol','icrc1_decimals','icrc1_fee','icrc1_total_supply','icrc1_supported_standards','icrc1_balance_of']);
const MAGIC=[68,73,68,76],TE=new TextEncoder(),TD=new TextDecoder('utf-8',{fatal:true});
export function candidLabel(name){let h=0;for(const b of TE.encode(name))h=(Math.imul(h,223)+b)>>>0;return h;}
export function uleb(n){check(typeof n==='bigint'&&n>=0n&&n<(1n<<1024n),'CANDID_NAT_RANGE');const a=[];do{let b=Number(n&127n);n>>=7n;if(n)b|=128;a.push(b);}while(n);return a;}
function sleb(raw){let n=BigInt(raw);const a=[];for(;;){const b=Number(n&127n);n>>=7n;const done=(n===0n&&(b&64)===0)||(n===-1n&&(b&64)!==0);a.push(done?b:b|128);if(done)return a;}}
function blob(hex){return Uint8Array.from(hex.match(/../g).map(x=>parseInt(x,16)));}
export function encodeIcrcReadArgs(method,options={}){
 check(READ_METHODS.includes(method),'ICRC_READ_METHOD_FORBIDDEN');
 if(method!=='icrc1_balance_of'){keys(options,[]);return Uint8Array.from([...MAGIC,0,0]);}
 keys(options,['account']);const a=icrcAccount(options.account),owner=principalBytes(a.owner);
 const fields=[{id:candidLabel('owner'),type:-24,bytes:[1,...uleb(BigInt(owner.length)),...owner]},
  {id:candidLabel('subaccount'),type:1,bytes:[1,32,...blob(a.subaccount)]}].sort((a,b)=>a.id-b.id);
 // table 0 = vec nat8; table 1 = opt 0; table 2 = Account record
 const table=[...sleb(-19),...sleb(-5),...sleb(-18),...sleb(0),...sleb(-20),2,...fields.flatMap(f=>[...uleb(BigInt(f.id)),...sleb(f.type)])];
 return Uint8Array.from([...MAGIC,3,...table,1,2,...fields.flatMap(f=>f.bytes)]);
}
function readDocument(bytes){
 check(bytes instanceof Uint8Array&&bytes.length>=6&&bytes.length<=262144,'CANDID_SIZE_INVALID');let i=0,budget=10000;
 const byte=()=>{check(i<bytes.length,'CANDID_TRUNCATED');return bytes[i++];};
 for(const m of MAGIC)check(byte()===m,'CANDID_MAGIC_INVALID');
 function leb(signed=false,limit=147){let n=0n,shift=0n,b;for(let c=0;c<limit;c++){b=byte();n|=BigInt(b&127)<<shift;shift+=7n;if(!(b&128)){if(signed&&(b&64))n-=1n<<shift;check(n>-(1n<<1024n)&&n<(1n<<1024n),'CANDID_NAT_RANGE');return n;}}throw Error('CANDID_LEB_LIMIT');}
 const size=(max)=>{const n=leb(false,5);check(n<=BigInt(max),'CANDID_RESOURCE_LIMIT');return Number(n);};
 const ref=()=>{const n=leb(true,5);check(n>=-24n&&n<=31n,'CANDID_TYPE_UNSUPPORTED');return Number(n);};
 const table=[],count=size(32);for(let t=0;t<count;t++){
  const op=ref();if(op===-18||op===-19)table.push({op,type:ref()});
  else if(op===-20){const fields=[],n=size(32);let prior=-1;for(let k=0;k<n;k++){const id=size(4294967295);check(id>prior,'CANDID_FIELD_ORDER_INVALID');prior=id;fields.push({id,type:ref()});}table.push({op,fields});}
  else throw Error('CANDID_TYPE_UNSUPPORTED');
 }
 const valid=t=>t>=0?t<table.length:[-1,-2,-3,-5,-15,-24].includes(t);
 for(const t of table){if(t.fields)for(const f of t.fields)check(valid(f.type),'CANDID_TYPE_REFERENCE_INVALID');else check(valid(t.type),'CANDID_TYPE_REFERENCE_INVALID');}
 const argc=size(1);check(argc===1,'CANDID_RESULT_ARITY_INVALID');const top=ref();check(valid(top),'CANDID_TYPE_REFERENCE_INVALID');
 function val(type,depth=0){check(--budget>=0&&depth<=24,'CANDID_RESOURCE_LIMIT');
  if(type===-1)return null;if(type===-2){const b=byte();check(b<=1,'CANDID_BOOL_INVALID');return b===1;}
  if(type===-3)return leb();if(type===-5)return byte();
  if(type===-15){const n=size(8192);check(i+n<=bytes.length,'CANDID_TRUNCATED');let s;try{s=TD.decode(bytes.subarray(i,i+n));}catch{throw Error('CANDID_UTF8_INVALID');}i+=n;return s;}
  if(type===-24){check(byte()===1,'CANDID_PRINCIPAL_REFERENCE_FORBIDDEN');const n=size(29);check(i+n<=bytes.length,'CANDID_TRUNCATED');const s=principalText(bytes.slice(i,i+n));i+=n;return s;}
  const t=table[type];check(t,'CANDID_TYPE_REFERENCE_INVALID');
  if(t.op===-18){const b=byte();check(b<=1,'CANDID_OPTION_INVALID');return b?[val(t.type,depth+1)]:[];}
  if(t.op===-19){const n=size(4096);check(n<=budget,'CANDID_RESOURCE_LIMIT');return Array.from({length:n},()=>val(t.type,depth+1));}
  const result={};for(const f of t.fields)result[String(f.id)]=val(f.type,depth+1);return result;
 }
 const value=val(top);check(i===bytes.length,'CANDID_TRAILING_DATA');return {value,top,table};
}
export function decodeIcrcReadReply(method,bytes){
 check(READ_METHODS.includes(method),'ICRC_READ_METHOD_FORBIDDEN');const {value,top,table}=readDocument(bytes);
 if(['icrc1_name','icrc1_symbol'].includes(method)){
  check(top===-15&&typeof value==='string'&&value.length>0&&value.length<=(method==='icrc1_symbol'?32:256)&&!/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value),'ICRC_TEXT_INVALID');return value;
 }
 if(method==='icrc1_decimals'){check(top===-5,'ICRC_REPLY_TYPE_INVALID');return value;}
 if(['icrc1_fee','icrc1_total_supply','icrc1_balance_of'].includes(method)){check(top===-3,'ICRC_REPLY_TYPE_INVALID');return value.toString();}
 const vec=table[top];check(vec?.op===-19&&vec.type>=0,'ICRC_REPLY_TYPE_INVALID');const rec=table[vec.type],name=candidLabel('name'),url=candidLabel('url');
 check(rec?.op===-20&&rec.fields.length===2&&rec.fields.every(f=>[name,url].includes(f.id)&&f.type===-15),'ICRC_REPLY_TYPE_INVALID');
 check(value.length>0&&value.length<=32,'ICRC_STANDARDS_LIMIT');const seen=new Set();
 return value.map(v=>{const n=v[String(name)],u=v[String(url)];check(typeof n==='string'&&n.length>0&&n.length<=128&&!/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(n)&&!seen.has(n),'ICRC_STANDARD_INVALID');seen.add(n);
  check(typeof u==='string'&&u.length<=512&&!/[\x00-\x20\x7f]/.test(u),'ICRC_STANDARD_URL_INVALID');let parsed;try{parsed=new URL(u);}catch{throw Error('ICRC_STANDARD_URL_INVALID');}
  check(parsed.protocol==='https:'&&!parsed.username&&!parsed.password,'ICRC_STANDARD_URL_INVALID');return {name:n,url:u};}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
}
