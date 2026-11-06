/** Bounded IBC Classic relayer wire format. Only UpdateClient + one packet action. */
import {need,uint,canonical} from '../wallet/lib/guard.mjs';
import {fieldBytes as b,fieldText as t,fieldUint as u,anyMessage} from '../wallet/codec/protobuf.mjs';
import {fields,one,ptext,only,decodePacket} from '../wallet/bridge/ibc-wire.mjs';
import {keyInfo,sha256,signDigest} from '../wallet/lib/keys.mjs';
import {cosmosAddress} from '../wallet/non-evm/cosmos-offline.mjs';
import {validatePacketForRoute} from './policy.mjs';
import * as secp from '../wallet/vendor/noble-secp256k1.mjs';
export const TYPES=Object.freeze({update:'/ibc.core.client.v1.MsgUpdateClient',header:'/ibc.lightclients.tendermint.v1.Header',receive:'/ibc.core.channel.v1.MsgRecvPacket',acknowledge:'/ibc.core.channel.v1.MsgAcknowledgement',timeout:'/ibc.core.channel.v1.MsgTimeout'});
const cat=(...x)=>Buffer.concat(x.flat());
const U64=(1n<<64n)-1n;
const num=v=>uint(String(v),U64);
function hex(v,size){need(typeof v==='string'&&/^(?:[a-f0-9]{2})*$/i.test(v),'RELAY_HEADER_HEX');const x=Buffer.from(v,'hex');need(size===undefined||x.length===size,'RELAY_HEADER_SIZE');return x;}
function base64(v,size){need(typeof v==='string'&&v.length<=24000,'RELAY_BASE64');const x=Buffer.from(v,'base64');need(x.toString('base64')===v&&(size===undefined||x.length===size),'RELAY_BASE64');return x;}
export function timestamp(s){
  const m=typeof s==='string'&&/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(s);need(m,'RELAY_TIME_FORMAT');
  const ms=Date.parse(m[1]+'Z');need(Number.isSafeInteger(ms)&&ms>=0&&new Date(ms).toISOString().slice(0,19)===m[1],'RELAY_TIME_RANGE');
  return cat(u(1,BigInt(ms/1000)),u(2,BigInt((m[2]??'').padEnd(9,'0')||'0')));
}
const signedInt=v=>{need(/^-?(0|[1-9][0-9]*)$/.test(String(v)),'RELAY_SIGNED_INT');const n=BigInt(v);need(n>=-(1n<<63n)&&n<(1n<<63n),'RELAY_SIGNED_INT_RANGE');return BigInt.asUintN(64,n);};
function blockId(v){return cat(b(1,hex(v.hash)),b(2,cat(u(1,num(v.parts.total)),b(2,hex(v.parts.hash)))));}
function validator(v){need(v.pub_key?.type==='tendermint/PubKeyEd25519','RELAY_ED25519_VALIDATOR_REQUIRED');return cat(b(1,hex(v.address,20)),b(2,b(1,base64(v.pub_key.value,32))),u(3,num(v.voting_power)),u(4,signedInt(v.proposer_priority)));}
export function validatorSet(list,proposer){
  need(Array.isArray(list)&&list.length>0&&list.length<=100,'RELAY_VALIDATOR_LIMIT');
  const p=list.find(v=>v.address.toUpperCase()===proposer.toUpperCase());need(p,'RELAY_PROPOSER_MISSING');
  need(new Set(list.map(v=>v.address.toUpperCase())).size===list.length,'RELAY_DUPLICATE_VALIDATOR');
  return cat(list.map(v=>b(1,validator(v))),b(2,validator(p)),u(3,list.reduce((n,v)=>n+num(v.voting_power),0n)));
}
export function encodeLightHeader(signedHeader,list,trustedList,trustedHeight,revision,proposerAtTrusted){
  const h=signedHeader.header,c=signedHeader.commit;need(String(h.height)===String(c.height)&&Array.isArray(c.signatures)&&c.signatures.length===list.length,'RELAY_COMMIT_HEADER');
  const hh=cat(b(1,cat(u(1,num(h.version.block)),u(2,num(h.version.app??0)))),t(2,h.chain_id),u(3,num(h.height)),b(4,timestamp(h.time)),b(5,blockId(h.last_block_id)),
    ['last_commit_hash','data_hash','validators_hash','next_validators_hash','consensus_hash','app_hash','last_results_hash','evidence_hash','proposer_address'].map((k,i)=>b(i+6,hex(h[k]))));
  const cc=cat(u(1,num(c.height)),u(2,num(c.round)),b(3,blockId(c.block_id)),c.signatures.map(s=>{
    need([1,2,3].includes(Number(s.block_id_flag)),'RELAY_COMMIT_FLAG');
    return b(4,cat(u(1,num(s.block_id_flag)),b(2,hex(s.validator_address)),...(Number(s.block_id_flag)===1?[]:[b(3,timestamp(s.timestamp)),b(4,base64(s.signature,64))])));
  }));
  return cat(b(1,cat(b(1,hh),b(2,cc))),b(2,validatorSet(list,h.proposer_address)),b(3,heightBytes({revision_number:revision,revision_height:String(trustedHeight)})),b(4,validatorSet(trustedList,proposerAtTrusted)));
}
export const heightBytes=h=>cat(u(1,num(h.revision_number)),u(2,num(h.revision_height)));
export const packetBytes=p=>cat(u(1,num(p.sequence)),t(2,p.source_port),t(3,p.source_channel),t(4,p.destination_port),t(5,p.destination_channel),b(6,base64(p.data)),b(7,heightBytes(p.timeout_height)),u(8,num(p.timeout_timestamp)));
export function relayBody({kind,packet,proofBase64,proofHeight,acknowledgement=null,clientId,updateHeaderBase64=null,signer}){
  need(['receive','acknowledge','timeout'].includes(kind),'RELAY_KIND');
  const pk=b(1,packetBytes(packet)),proof=base64(proofBase64);need(proof.length>0&&proof.length<=12000,'RELAY_PROOF_LIMIT');
  let msg;
  if(kind==='receive')msg=cat(pk,b(2,proof),b(3,heightBytes(proofHeight)),t(4,signer));
  else if(kind==='acknowledge')msg=cat(pk,b(2,base64(acknowledgement)),b(3,proof),b(4,heightBytes(proofHeight)),t(5,signer));
  else msg=cat(pk,b(2,proof),b(3,heightBytes(proofHeight)),u(4,1n),t(5,signer));
  const messages=[];
  if(updateHeaderBase64)messages.push(anyMessage(TYPES.update,cat(t(1,clientId),b(2,anyMessage(TYPES.header,base64(updateHeaderBase64))),t(3,signer))));
  messages.push(anyMessage(TYPES[kind],msg));
  return messages.map(m=>b(1,m));
}
export function allowedBody(body,route,kind,packet,signer,timeoutHeight){
  validatePacketForRoute(packet,route);const bd=fields(body);only(bd,[1,2,3]);
  need(ptext(bd,2,true)==='RealDEX bounded IBC relay'&&one(bd,3,0)===BigInt(timeoutHeight),'RELAY_BODY_CONTEXT');
  const messages=bd.get(1)??[];need(messages.length>=1&&messages.length<=2&&messages.every(x=>x.wire===2),'RELAY_MESSAGE_COUNT');
  if(messages.length===2){
    const a=fields(messages[0].value);only(a,[1,2]);need(ptext(a,1)===TYPES.update,'RELAY_FIRST_MESSAGE_FORBIDDEN');
    const m=fields(one(a,2));only(m,[1,2,3]);const side=kind==='receive'?route.destination:route.source;
    need(ptext(m,1)===side.client&&ptext(m,3)===signer,'RELAY_CLIENT_BINDING');
    const header=fields(one(m,2));only(header,[1,2]);need(ptext(header,1)===TYPES.header&&one(header,2).length>0,'RELAY_HEADER_TYPE');
  }
  const a=fields(messages.at(-1).value);only(a,[1,2]);need(ptext(a,1)===TYPES[kind],'RELAY_MESSAGE_FORBIDDEN');
  const m=fields(one(a,2));only(m,kind==='receive'?[1,2,3,4]:[1,2,3,4,5]);
  need(canonical(decodePacket(one(m,1)))===canonical(packet)&&ptext(m,kind==='receive'?4:5)===signer,'RELAY_PACKET_OR_SIGNER_BINDING');
  if(kind==='timeout')need(one(m,4,0)===1n,'RELAY_UNORDERED_ONLY');
  need(one(m,kind==='acknowledge'?3:2).length>0,'RELAY_PROOF_REQUIRED');return true;
}
export function transactionParts(a,publicKeyHex){
  const pub=hex(publicKeyHex,33),body=base64(a.bodyBase64);need(body.length<=14000,'RELAY_TX_LIMIT');
  const signer=cat(b(1,anyMessage('/cosmos.crypto.secp256k1.PubKey',b(1,pub))),b(2,b(1,u(1,1n))),u(3,num(a.sequence)));
  const fee=cat(b(1,cat(t(1,a.feeDenom),t(2,a.feeAtomic))),u(2,num(a.gasLimit)));
  const auth=cat(b(1,signer),b(2,fee));
  const signDoc=cat(b(1,body),b(2,auth),t(3,a.chainId),u(4,num(a.accountNumber)));
  return {body,auth,signDoc};
}
export function makeBody(plan,timeoutHeight){return cat(relayBody(plan),t(2,'RealDEX bounded IBC relay'),u(3,num(timeoutHeight))).toString('base64');}
export function signAction(a,route,packet,secret){
  const info=keyInfo('cosmos',secret),signer=cosmosAddress(info.publicKeyHex,(a.kind==='receive'?route.destination:route.source).network.hrp);
  allowedBody(base64(a.bodyBase64),route,a.kind,packet,signer,a.timeoutHeight);
  const p=transactionParts(a,info.publicKeyHex),sig=Buffer.from(signDigest(secret,sha256(p.signDoc)).toCompactRawBytes());
  const raw=cat(b(1,p.body),b(2,p.auth),b(3,sig));need(raw.length<=16384,'RELAY_TX_LIMIT');
  return {txRawBase64:raw.toString('base64'),txHash:sha256(raw).toString('hex').toUpperCase()};
}
export function verifyAction(a,route,packet,publicKeyHex){
  const n=(a.kind==='receive'?route.destination:route.source).network;need(a.networkId===n.id&&a.chainId===n.chainId&&a.feeDenom===n.feeDenom,'RELAY_ACTION_NETWORK');
  allowedBody(base64(a.bodyBase64),route,a.kind,packet,cosmosAddress(publicKeyHex,n.hrp),a.timeoutHeight);
  const p=transactionParts(a,publicKeyHex),raw=base64(a.txRawBase64),m=fields(raw);only(m,[1,2,3]);
  need(one(m,1).equals(p.body)&&one(m,2).equals(p.auth)&&one(m,3).length===64&&secp.verify(one(m,3),sha256(p.signDoc),hex(publicKeyHex),{lowS:true})&&sha256(raw).toString('hex').toUpperCase()===a.txHash,'RELAY_SIGNATURE_INVALID');return true;
}
