/** Bounded CBOR subset used by anonymous ICP metadata queries. Accepts unsigned
 * /negative uint64, text, bytes, definite arrays/maps, bool/null and outer tag 55799.
 * Indefinite values, floats, duplicate keys and unknown tags fail closed. */
import {check,object} from '../extended/guard.mjs';
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
export function encodeCbor(input,{tag=true}={}){
 const out=[];let nodes=0;const add=bytes=>{check(out.length+bytes.length<=16384,'CBOR_SIZE_LIMIT');for(const b of bytes)out.push(b);};
 const head=(major,raw)=>{const n=BigInt(raw);check(n>=0n&&n<(1n<<64n),'CBOR_INTEGER_RANGE');
  if(n<24n)add([major*32+Number(n)]);else {const size=n<=255n?1:n<=65535n?2:n<=4294967295n?4:8;add([major*32+({1:24,2:25,4:26,8:27}[size])]);for(let i=size-1;i>=0;i--)add([Number((n>>BigInt(i*8))&255n)]);}};
 function emit(x,depth){check(depth<=32&&++nodes<=4096,'CBOR_RESOURCE_LIMIT');
  if(x instanceof Uint8Array){head(2,x.length);add(x);}
  else if(typeof x==='string'){const bytes=encoder.encode(x);head(3,bytes.length);add(bytes);}
  else if(typeof x==='number'||typeof x==='bigint'){check(typeof x==='bigint'||Number.isSafeInteger(x),'CBOR_INTEGER_RANGE');const n=BigInt(x);head(n>=0n?0:1,n>=0n?n:-1n-n);}
  else if(x===true)add([245]);else if(x===false)add([244]);else if(x===null)add([246]);
  else if(Array.isArray(x)){head(4,x.length);for(const v of x)emit(v,depth+1);}
  else {object(x,'CBOR_VALUE_UNSUPPORTED');const entries=Object.entries(x);check(entries.every(([k])=>!['__proto__','constructor','prototype'].includes(k)),'CBOR_KEY_INVALID');head(5,entries.length);for(const [k,v]of entries){emit(k,depth+1);emit(v,depth+1);}}
 }
 if(tag)add([217,217,247]);emit(input,0);return Uint8Array.from(out);
}
export function decodeCbor(bytes,{maxBytes=2097152,maxNodes=50000,maxDepth=32}={}){
 check(bytes instanceof Uint8Array&&bytes.length<=maxBytes,'CBOR_SIZE_LIMIT');let i=0,nodes=0;
 const byte=()=>{check(i<bytes.length,'CBOR_TRUNCATED');return bytes[i++];};
 function length(ai){if(ai<24)return BigInt(ai);check([24,25,26,27].includes(ai),'CBOR_LENGTH_UNSUPPORTED');let n=0n;for(let k=0;k<({24:1,25:2,26:4,27:8}[ai]);k++)n=(n<<8n)|BigInt(byte());return n;}
 function read(depth,outer=false){check(depth<=maxDepth&&++nodes<=maxNodes,'CBOR_RESOURCE_LIMIT');const b=byte(),major=b>>5,ai=b&31;
  if(major===7){if(ai===20)return false;if(ai===21)return true;if(ai===22)return null;throw Error('CBOR_VALUE_UNSUPPORTED');}
  const n=length(ai);if(major===0)return n;if(major===1)return -1n-n;
  if(major===6){check(outer&&n===55799n,'CBOR_TAG_UNSUPPORTED');return read(depth+1,false);}
  check(n<=BigInt(maxBytes),'CBOR_SIZE_LIMIT');const size=Number(n);
  if(major===2||major===3){check(i+size<=bytes.length,'CBOR_TRUNCATED');const raw=bytes.slice(i,i+size);i+=size;if(major===2)return raw;try{return decoder.decode(raw);}catch{throw Error('CBOR_UTF8_INVALID');}}
  check(size<=maxNodes,'CBOR_RESOURCE_LIMIT');if(major===4){const a=[];for(let k=0;k<size;k++)a.push(read(depth+1));return a;}
  if(major===5){const obj={};for(let k=0;k<size;k++){const key=read(depth+1);check(typeof key==='string'&&key.length<=256&&!Object.hasOwn(obj,key)&&!['__proto__','constructor','prototype'].includes(key),'CBOR_KEY_INVALID');obj[key]=read(depth+1);}return obj;}
  throw Error('CBOR_VALUE_UNSUPPORTED');
 }
 const value=read(0,true);check(i===bytes.length,'CBOR_TRAILING_DATA');return value;
}
