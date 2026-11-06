/** Small bounded protobuf/gRPC-Web decoder for two read-only Injective RPCs.
 * No signing, arbitrary RPC dispatch, streams, compression, or text/base64 gRPC. */
import {need} from './math.mjs';
const te=new TextEncoder(), td=new TextDecoder('utf-8',{fatal:true});
export function join(...parts) { const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out; }
export function varint(n) { need(typeof n==='bigint'&&n>=0n&&n<2n**64n,'PROTO_UINT');const b=[];do{b.push(Number(n&127n)|(n>127n?128:0));n>>=7n;}while(n);return Uint8Array.from(b); }
export const field=(id,bytes)=>join(varint(BigInt(id*8+2)),varint(BigInt(bytes.length)),bytes);
export const str=(id,s)=>field(id,te.encode(s));
export const vint=(id,n)=>join(varint(BigInt(id*8)),varint(n));
export function fields(bytes) {
 need(bytes instanceof Uint8Array&&bytes.length<=2097152,'PROTO_SIZE');const out=new Map();let at=0,count=0;
 function readVar(){let n=0n;for(let k=0;k<10;k++){need(at<bytes.length,'PROTO_TRUNCATED');const b=bytes[at++];need(k<9||b<=1,'PROTO_OVERFLOW');n|=BigInt(b&127)<<BigInt(7*k);if(!(b&128)){need(k===0||b!==0,'PROTO_NONCANONICAL');return n;}}throw Error('PROTO_OVERFLOW');}
 while(at<bytes.length){need(++count<=12000,'PROTO_FIELDS');const tag=readVar(),id=Number(tag>>3n),wire=Number(tag&7n);need(id>0&&id<2**29,'PROTO_TAG');let value;
  if(wire===0)value=readVar();else if([1,2,5].includes(wire)){const len=wire===2?Number(readVar()):wire===1?8:4;need(Number.isSafeInteger(len)&&len>=0&&len<=bytes.length-at,'PROTO_TRUNCATED');value=bytes.slice(at,at+len);at+=len;}else throw Error('PROTO_WIRE');
  if(!out.has(id))out.set(id,[]);out.get(id).push({wire,value});
 }return out;
}
export function one(f,id,wire,defaultValue) { const a=f.get(id)??[];need(a.length<=1,'PROTO_DUPLICATE');if(!a.length){need(defaultValue!==undefined,'PROTO_MISSING');return defaultValue;}need(a[0].wire===wire,'PROTO_WIRE');return a[0].value; }
export function text(f,id,def) { let b=one(f,id,2,def===undefined?undefined:te.encode(def));try{return td.decode(b);}catch{throw Error('PROTO_UTF8');} }
const sint=n=>(n>>1n)^(-(n&1n));
function meta(bytes){const f=fields(bytes);return {symbol:text(f,3,''),decimals:sint(one(f,5,0,0n)).toString()};}
export function decodeMarket(bytes) {const outer=fields(bytes),f=fields(one(outer,1,2));return {marketId:text(f,1),marketStatus:text(f,2),ticker:text(f,3),baseDenom:text(f,4),baseTokenMeta:meta(one(f,5,2)),quoteDenom:text(f,6),quoteTokenMeta:meta(one(f,7,2)),takerFeeRate:text(f,9),minPriceTickSize:text(f,11),minQuantityTickSize:text(f,12),...(f.has(13)?{minNotional:text(f,13)}:{})};}
export function decodeBook(bytes) {const outer=fields(bytes),f=fields(one(outer,1,2));const levels=id=>(f.get(id)??[]).map(x=>{need(x.wire===2,'PROTO_WIRE');const p=fields(x.value);return {price:text(p,1),quantity:text(p,2)};});return {buys:levels(1),sells:levels(2),sequence:one(f,3,0,0n).toString(),timestamp:sint(one(f,4,0,0n)).toString(),height:sint(one(f,5,0,0n)).toString()};}
export function frame(payload,flag=0) {need(payload.length<=2097152,'GRPC_SIZE');const head=new Uint8Array(5);head[0]=flag;new DataView(head.buffer).setUint32(1,payload.length);return join(head,payload);}
export function unary(bytes,headerStatus=null) {
 let at=0,data=null,trailers=false,status=null;need(bytes.length<=2097152,'GRPC_SIZE');
 while(at<bytes.length){need(!trailers&&at+5<=bytes.length,'GRPC_FRAMING');const flag=bytes[at],len=new DataView(bytes.buffer,bytes.byteOffset+at+1,4).getUint32(0);at+=5;need(at+len<=bytes.length,'GRPC_TRUNCATED');const p=bytes.slice(at,at+len);at+=len;
  if(flag===0){need(data===null,'GRPC_MULTIPLE_MESSAGES');data=p;}else if(flag===128){trailers=true;need(len<=8192,'GRPC_TRAILERS');let s;try{s=td.decode(p);}catch{throw Error('GRPC_TRAILERS');}const seen=new Set();for(const line of s.replace(/\r\n$/,'').split('\r\n')){const m=/^([a-z0-9-]+): ?([^\r\n]*)$/.exec(line);need(m&&!seen.has(m[1]),'GRPC_TRAILERS');seen.add(m[1]);if(m[1]==='grpc-status')status=m[2];}}else throw Error('GRPC_COMPRESSION_UNSUPPORTED');
 }
 need(trailers&&status==='0'&&(headerStatus===null||headerStatus==='0'),'GRPC_STATUS');need(data!==null,'GRPC_MISSING_MESSAGE');return data;
}
export function marketRequest(id) { return frame(str(1,id)); }
export function bookRequest(id,depth=50) { need(Number.isInteger(depth)&&depth>=1&&depth<=100,'SPOT_DEPTH');return frame(join(str(1,id),vint(2,BigInt(depth*2)))); }
