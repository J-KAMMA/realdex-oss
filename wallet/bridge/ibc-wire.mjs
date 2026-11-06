/** Bounded protobuf reader for transaction evidence, not a general-purpose schema decoder. */
import {need} from '../lib/guard.mjs';
export function fields(input){
 const b=Buffer.from(input);need(b.length<=16384,'IBC_PROTO_LIMIT');let at=0;const out=new Map();let count=0;
 const v=()=>{let n=0n,s=0n,start=at;for(let i=0;i<10;i++){need(at<b.length,'IBC_PROTO_TRUNCATED');const c=b[at++];need(i!==9||c<=1,'IBC_PROTO_OVERFLOW');n|=BigInt(c&127)<<s;if(!(c&128)){need(at-start===1||c!==0,'IBC_PROTO_NONCANONICAL');return n;}s+=7n;}throw Error('IBC_PROTO_VARINT');};
 while(at<b.length){need(++count<=256,'IBC_PROTO_LIMIT');const tag=v(),key=Number(tag>>3n),wire=Number(tag&7n);need(key>0&&key<=536870911&&(wire===0||wire===2),'IBC_PROTO_FIELD');let value;
  if(wire===0)value=v();else{const size=v();need(size<=BigInt(b.length-at),'IBC_PROTO_TRUNCATED');value=b.subarray(at,at+Number(size));at+=Number(size);}
  const list=out.get(key)??[];list.push({wire,value});out.set(key,list);
 }return out;
}
export function one(m,k,wire=2,optional=false){const a=m.get(k)??[];if(!a.length&&optional)return wire===2?Buffer.alloc(0):0n;need(a.length===1&&a[0].wire===wire,'IBC_PROTO_CARDINALITY');return a[0].value;}
export function ptext(m,k,optional=false){let s;try{s=new TextDecoder('utf-8',{fatal:true}).decode(one(m,k,2,optional));}catch{throw Error('IBC_PROTO_UTF8');}return s;}
export function only(m,keys){need([...m.keys()].every(k=>keys.includes(k)),'IBC_PROTO_UNKNOWN_FIELD');}
export function decodePacket(bytes){const m=fields(bytes);only(m,[1,2,3,4,5,6,7,8]);const h=fields(one(m,7,2,true));only(h,[1,2]);return {sequence:String(one(m,1,0)),source_port:ptext(m,2),source_channel:ptext(m,3),destination_port:ptext(m,4),destination_channel:ptext(m,5),data:one(m,6).toString('base64'),timeout_height:{revision_number:String(one(h,1,0,true)),revision_height:String(one(h,2,0,true))},timeout_timestamp:String(one(m,8,0,true))};}
export function singleMessage(raw){const r=fields(raw);only(r,[1,2,3]);const body=fields(one(r,1));only(body,[1,2,3]);const a=fields(one(body,1));only(a,[1,2]);return {type:ptext(a,1),value:one(a,2),body,auth:one(r,2)};}
/** A relayer may atomically update the light client before its sole packet message.
 * No transfer, authz, feegrant, or arbitrary extra message is accepted here. */
function relayTransaction(raw){
 const r=fields(raw);only(r,[1,2,3]);const body=fields(one(r,1));only(body,[1,2,3]);
 const messages=body.get(1)??[];need(messages.length===1||messages.length===2,'IBC_RELAY_MESSAGE_COUNT');
 need(messages.every(x=>x.wire===2),'IBC_RELAY_MESSAGE_WIRE');
 if(messages.length===2){
  const a=fields(messages[0].value);only(a,[1,2]);need(ptext(a,1)==='/ibc.core.client.v1.MsgUpdateClient','IBC_RELAY_PREFIX_FORBIDDEN');
  const update=fields(one(a,2));only(update,[1,2,3]);need(/^07-tendermint-[0-9]+$/.test(ptext(update,1))&&ptext(update,3).length>0,'IBC_RELAY_UPDATE_INVALID');
  const h=fields(one(update,2));only(h,[1,2]);need(ptext(h,1)==='/ibc.lightclients.tendermint.v1.Header'&&one(h,2).length>0,'IBC_RELAY_UPDATE_TYPE');
 }
 const a=fields(messages.at(-1).value);only(a,[1,2]);return {type:ptext(a,1),value:one(a,2),body,auth:one(r,2),messageIndex:messages.length-1};
}
export function decodeRelay(raw,kind){const tx=relayTransaction(raw),m=fields(tx.value);if(kind==='receive'){only(m,[1,2,3,4]);return {...tx,packet:decodePacket(one(m,1)),signer:ptext(m,4)};}if(kind==='acknowledge'){only(m,[1,2,3,4,5]);return {...tx,packet:decodePacket(one(m,1)),acknowledgement:one(m,2).toString('base64'),signer:ptext(m,5)};}only(m,[1,2,3,4,5]);return {...tx,packet:decodePacket(one(m,1)),signer:ptext(m,5)};}
