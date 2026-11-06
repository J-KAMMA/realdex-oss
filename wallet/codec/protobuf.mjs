/** Minimal deterministic Protobuf wire encoder. Not an arbitrary-message signer. */
import {need} from '../lib/guard.mjs';
export function varint(n){need(typeof n==='bigint'&&n>=0n&&n<(1n<<64n),'PROTO_UINT64');const b=[];do{b.push(Number(n&127n)|(n>=128n?128:0));n>>=7n;}while(n);return Buffer.from(b);}
export function fieldBytes(field,value){need(Number.isInteger(field)&&field>0&&field<536870912,'PROTO_FIELD_INVALID');const b=Buffer.from(value);need(b.length<=16384,'PROTO_FIELD_SIZE');return Buffer.concat([varint(BigInt(field)*8n+2n),varint(BigInt(b.length)),b]);}
export const fieldText=(f,v)=>fieldBytes(f,Buffer.from(v,'utf8'));
export const fieldUint=(f,n)=>n===0n?Buffer.alloc(0):Buffer.concat([varint(BigInt(f)*8n),varint(n)]);
export const anyMessage=(type,bytes)=>Buffer.concat([fieldText(1,type),fieldBytes(2,bytes)]);
