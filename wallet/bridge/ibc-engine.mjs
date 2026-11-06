import {discoverIbcEvidence} from './ibc-discovery.mjs';
/** Durable bridge lifecycle; never infer refund authority from wall-clock expiry. */
import {need,clone,canonical,safeError} from '../lib/guard.mjs';
import {keyInfo} from '../lib/keys.mjs';
import {fingerprint} from '../non-evm/solana-codec.mjs';
import {validateIbcRoute,ibcRouteFingerprint,routeAssets,IBC_OPERATION,IBC_ASSURANCE} from './ibc-config.mjs';
import {ibcFrom,ibcUser,ibcPaymentHash,makeIbcIntent,signIbc,verifyIbcSigned} from './ibc-codec.mjs';
import {IbcAdapter,IbcRpc} from './ibc-network.mjs';
export class IbcEngine {
 constructor({rpc=new IbcRpc(),now=Date.now}={}){this.now=now;this.rpc=rpc;this.adapter=new IbcAdapter(rpc,now);this.active=new Set();}
 publicAccount(a){let secret;try{need(a.family==='cosmos'&&a.kind==='local'&&typeof a.secretHex==='string','IBC_LOCAL_ACCOUNT_REQUIRED');secret=Buffer.from(a.secretHex,'hex');const info=keyInfo('cosmos',secret);need(info.address===a.address,'IBC_ACCOUNT_BINDING');return {id:a.id,family:a.family,kind:a.kind,address:a.address,publicKeyHex:info.publicKeyHex};}finally{secret?.fill(0);}}
 normalize(r,a,p){return ibcUser(r,a,p);}
 hash(r,a,u){return ibcPaymentHash(r,a,u);}
 unresolved(records,r,a){need(!records.some(v=>v.family==='cosmos'&&v.summary.from===a.address&&v.summary.networkId===r.source.network.id&&!['reported-confirmed','reported-reverted'].includes(v.state)),'IBC_ACCOUNT_UNRESOLVED');}
 async balance(route,account){const r=validateIbcRoute(route),a=this.publicAccount(account),heads=await this.adapter.lane(r),from=ibcFrom(a,r),assets=routeAssets(r);return {networkId:r.source.network.id,sourceDenom:assets.sourceDenom,destinationDenom:assets.destinationDenom,from,decimals:r.asset.decimals,balanceAtomic:await this.adapter.amount(r.source.network,from,assets.sourceDenom,heads.sourceHead.height,true),feeBalanceAtomic:await this.adapter.amount(r.source.network,from,r.source.network.feeDenom,heads.sourceHead.height,true),assurance:IBC_ASSURANCE,finalityProven:false};}
 async prepare(route,account,raw){const r=validateIbcRoute(route),a=this.publicAccount(account),u=this.normalize(r,a,raw),checked=await this.adapter.inspect(r,a,u),intent=makeIbcIntent(r,a,u,checked,this.now());await this.adapter.inspect(r,a,u,intent.payment);this.verifyIntent(r,intent);return intent;}
 verifyIntent(r,i){const {id,...rest}=i;need(fingerprint(rest)===id&&i.routeFingerprint===ibcRouteFingerprint(r),'IBC_INTENT_CHANGED');need(this.now()>=i.createdAt&&this.now()<i.expiresAt,'IBC_INTENT_EXPIRED');}
 async sign(vault,route,intent,{authorize=()=>{}}={}){const r=validateIbcRoute(route);vault.check();const epoch=vault.epoch,a=this.publicAccount(vault.account(intent.accountId));const guard=()=>{authorize();vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');this.verifyIntent(r,intent);};guard();this.unresolved(await vault.nonEvmRecords(),r,a);guard();await this.adapter.inspect(r,a,intent.userPayment,intent.payment);guard();return vault.signNonEvmAndRecord(intent,secret=>{guard();return signIbc(secret,intent.payment);});}
 async current(vault,r,candidate){const record=(await vault.nonEvmRecords()).find(v=>v.id===candidate.id);need(record?.summary.operation===IBC_OPERATION&&record.summary.routeFingerprint===ibcRouteFingerprint(r),'IBC_RECORD_ROUTE_CHANGED');verifyIbcSigned(record.signed,record.summary);return record;}
 report(stage,reason,evidenceRefs={},extra={}){return {observedAt:this.now(),stage,received:false,refunded:false,completed:false,reason,assurance:IBC_ASSURANCE,finalityProven:false,stateProofVerified:false,timeoutElapsed:false,evidenceRefs,...extra};}
 async broadcast(vault,route,candidate,{authorize=()=>{}}={}){const r=validateIbcRoute(route);need(r.source.network.broadcastEnabled,'BROADCAST_DISABLED');vault.check();const epoch=vault.epoch,key=candidate.accountId;need(!this.active.has(key),'IBC_OPERATION_BUSY');this.active.add(key);const guard=()=>{authorize();vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');};
  try{let record=await this.current(vault,r,candidate);guard();need(record.state==='signed','IBC_RESUBMISSION_NOT_IMPLEMENTED');const a=this.publicAccount(vault.account(record.accountId));await this.adapter.inspect(r,a,record.summary.userPayment,record.summary.transfer);guard();
   record=await vault.observeNonEvm(record,'broadcast-unknown',this.report('source-unresolved','submission-starting'));guard();let report=this.report('source-unresolved','RPC-accepted-not-confirmed'),state='broadcast';
   try{await this.adapter.submit(r,record);}catch(e){state='broadcast-unknown';report=this.report('source-unresolved',safeError(e));}guard();return vault.observeNonEvm(record,state,report);
  }finally{this.active.delete(key);}
 }
 async reconcile(vault,route,candidate,refs={},{discover=false,authorize=()=>{}}={}){
  const r=validateIbcRoute(route);vault.check();const epoch=vault.epoch,record=await this.current(vault,r,candidate);let evidenceRefs={...record.report?.evidenceRefs,...refs};
  const guard=()=>{authorize();vault.check();need(vault.epoch===epoch,'LOCK_INTERRUPTED_OPERATION');};guard();
  let state=record.state==='signed'?'signed':'broadcast-unknown',report=this.report(state==='signed'?'signed':'source-unresolved','not-yet-observed',evidenceRefs);
  try{
   const source=await this.adapter.source(r,record);report.source=source.evidence;
   if(source.evidence.executionCode!=='0'){state='reported-reverted';report={...report,stage:'source-failed',reason:'source-execution-failed',completed:true};}
   else {
    const packet=source.packet;if(record.report?.packet)need(canonical(record.report.packet)===canonical(packet),'IBC_PACKET_IDENTITY_CHANGED');report.packet=packet;
    const candidates=discover?await discoverIbcEvidence(this.adapter,r,record,source,{authorize:guard}):evidenceRefs;guard();
    state='broadcast';report.stage='awaiting-receive';report.reason='source-included-not-delivered';
    const head=await this.adapter.head(r.destination.network);report.timeoutElapsed=BigInt(head.time)*1000000n>=BigInt(packet.timeout_timestamp);if(report.timeoutElapsed){report.stage='awaiting-refund';report.reason='deadline-elapsed-not-a-refund';}
    let destination=null;
    if(candidates.destinationTxHash){destination=await this.adapter.destination(r,record,packet,candidates.destinationTxHash);evidenceRefs.destinationTxHash=candidates.destinationTxHash;report.evidenceRefs=evidenceRefs;report.destination=destination.evidence;report.acknowledgement=destination.acknowledgement;report.stage=destination.outcome.success?'awaiting-ack':'awaiting-refund';report.reason=destination.outcome.success?'destination-received-source-ack-pending':'destination-error-refund-not-yet-observed';}
    if(candidates.settlementTxHash){const settlement=await this.adapter.settlement(r,record,packet,candidates.settlementTxHash,destination);evidenceRefs.settlementTxHash=candidates.settlementTxHash;report.evidenceRefs=evidenceRefs;report.settlement=settlement.evidence;report.settlementKind=settlement.kind;report.completed=true;
     if(settlement.refunded){need(!destination?.outcome.success,'IBC_REFUND_AFTER_DELIVERY_CONFLICT');state='reported-reverted';report.refunded=true;report.refundDeltaAtomic=record.summary.amountAtomic;report.stage='reported-refunded';report.reason='source-chain-refund-observed';}
     else {need(destination?.outcome.success,'IBC_DELIVERY_EVIDENCE_REQUIRED');state='reported-confirmed';report.received=true;report.stage='reported-delivered';report.reason='destination-and-source-ack-observed';}
    }
   }
  }catch(e){state=record.state==='signed'?'signed':'broadcast-unknown';report=this.report('inconsistent',safeError(e),evidenceRefs,record.report?.packet?{packet:clone(record.report.packet)}:{});}
  guard();return vault.observeNonEvm(record,state,report,{authorize:guard});
 }
}
