/** Anonymous ICRC reader. This deliberately does not interpret a query signature
 * or a /status root_key as proof. Verified agents/certified-data validation are a
 * separate, not-yet-connected trust path. NO /call or mutation methods exist here. */
import {check,keys,freeze,endpointConfigs,makeClock,boundedSignal} from '../extended/guard.mjs';
import {readHttp} from '../extended/http.mjs';
import {canonical} from '../chains/core.mjs';
import {principalBytes,canisterPrincipal,icrcAsset} from './principal.mjs';
import {encodeCbor,decodeCbor} from './cbor.mjs';
import {encodeIcrcReadArgs,decodeIcrcReadReply,READ_METHODS} from './candid.mjs';
export function createIcrcReader({network,ledger,endpoint,access={},headers={},signal,fetchImpl,now=Date.now,allowAccountQuery=false}){
 const asset=icrcAsset(network,ledger),id=canisterPrincipal(ledger);check(typeof allowAccountQuery==='boolean','ACCOUNT_QUERY_POLICY_INVALID');
 const http=readHttp(endpoint,{access,headers,signal,fetchImpl,maxBytes:262144}),clock=makeClock(now,signal);
 return Object.freeze({asset,async query(method,options={}){
  check(READ_METHODS.includes(method),'ICRC_READ_METHOD_FORBIDDEN');check(method!=='icrc1_balance_of'||allowAccountQuery,'ACCOUNT_DISCLOSURE_NOT_AUTHORIZED');
  const arg=encodeIcrcReadArgs(method,options),at=clock();
  const content={request_type:'query',canister_id:principalBytes(id),method_name:method,arg,sender:new Uint8Array([4]),ingress_expiry:BigInt(at)*1000000n+60000000000n};
  const raw=await http({path:'/api/v2/canister/'+id+'/query',bytes:encodeCbor({content}),contentType:'application/cbor',responseType:'cbor'});clock();
  const r=decodeCbor(raw);check(r&&r.status==='replied','ICRC_QUERY_REJECTED');check(r.reply?.arg instanceof Uint8Array,'ICRC_REPLY_INVALID');
  return decodeIcrcReadReply(method,r.reply.arg);
 }});
}
const METADATA_METHODS=['icrc1_name','icrc1_symbol','icrc1_decimals','icrc1_fee','icrc1_supported_standards'];
export async function observeIcrcLedger({network,ledger,endpoints,access={},signal,fetchImpl,now=Date.now}){
 const asset=icrcAsset(network,ledger),configs=endpointConfigs(endpoints,access),joined=boundedSignal(signal,60000),clock=makeClock(now,joined);clock();
 const readers=configs.map(e=>createIcrcReader({network,ledger,endpoint:e.url,headers:e.headers,access,signal:joined,fetchImpl,now:clock}));
 const read=async r=>{const v={};for(const m of METADATA_METHODS)v[m]=await r.query(m);return v;};
 const first=await Promise.all(readers.map(read));clock();const repr=canonical(first[0]);check(first.every(v=>canonical(v)===repr),'ICRC_METADATA_DISAGREEMENT');
 const second=await Promise.all(readers.map(read));const observedAt=clock();check(second.every(v=>canonical(v)===repr),'ICRC_METADATA_CHANGED');
 const data=first[0];check(data.icrc1_supported_standards.some(s=>s.name==='ICRC-1'),'ICRC1_NOT_REPORTED');
 return freeze({schema:'realdex.icrc-observation.v1',asset,name:data.icrc1_name,symbol:data.icrc1_symbol,decimals:data.icrc1_decimals,
  transferFeeAtomic:data.icrc1_fee,reportedStandards:data.icrc1_supported_standards,observedAt,expiresAt:observedAt+30000,
  readerCount:readers.length,assurance:{rpcAgreement:readers.length>=2,metadataStableAcrossReads:true,sameStateSnapshot:false,
   rootTrustVerified:false,responseSignatureVerified:false,certifiedLedgerState:false,ledgerImplementationVerified:false},
  disclosure:{accountQueried:false,keysRequested:false,topologyIncluded:false,peerPublicationAllowed:false},
  executable:false,notes:['Uncertified query observations only. Agreement and repeated reads are not a proof.',
   'Decimals and fees can change after this observation. Metadata endpoints do not identify a single ledger state.',
   'A self-reported ICRC standard is not a behavioral or deduplication guarantee.']});
}
