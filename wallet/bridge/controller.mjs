import {IbcMonitor,monitorOptions} from './ibc-monitor.mjs';
/** Owner-only asset bridge API. Does not extend the dapp /bridge transport or AI MCP. */
import {need,shape,clone,safeError} from '../lib/guard.mjs';
import {validateSettings} from '../lib/network.mjs';
import {IbcEngine} from './ibc-engine.mjs';
import {validateIbcRoute,ibcRouteFingerprint,routeConfirmation,IBC_OPERATION} from './ibc-config.mjs';
export class IbcController {
 constructor(server){
  this.server=server;this.engine=new IbcEngine({now:server.now});
  this.monitor=new IbcMonitor({now:server.now,available:()=>!server.vault.status().locked&&!server.nonEvm.restartRequired,
   busy:()=>server.nonEvm.busy||server.activeApproval||[...server.requests.values()].some(r=>['pending','preparing','processing'].includes(r.state)),
   probe:(id,{authorize})=>server.nonEvm.withOperation(async()=>{
    authorize();const records=await server.vault.nonEvmRecords();authorize();
    const record=records.find(r=>r.id===id&&r.summary.operation===IBC_OPERATION);need(record&&record.state!=='signed','IBC_TRACKING_RECORD_INVALID');
    return this.engine.reconcile(server.vault,this.route(record.summary.route.id),record,{},{discover:true,authorize});
   })});
 }
 invalidate(code='WALLET_INVALIDATED'){this.monitor.stop(code);}

 route(id){const r=(this.server.settings.ibcRoutes??[]).find(r=>r.id===id);need(r,'IBC_ROUTE_NOT_CONFIGURED');return r;}
 async api(path,b){const s=this.server;
  if(path==='/api/ibc/monitor/stop'){shape(b,[]);return this.monitor.stop();}
  if(path==='/api/ibc/monitor/status'){shape(b,[]);if(s.vault.status().locked)this.monitor.stop('WALLET_LOCKED');return this.monitor.status();}
  s.vault.check();need(!s.nonEvm.restartRequired,'NON_EVM_SETTINGS_RESTART_REQUIRED');
  if(path==='/api/ibc/routes'){shape(b,[]);return {routes:s.settings.ibcRoutes??[],mainnetEnabled:false,agentSigningEnabled:false};}
  if(path==='/api/ibc/routes/inspect'){shape(b,['route']);const route=validateIbcRoute(b.route);return {route,fingerprint:ibcRouteFingerprint(route),confirmation:routeConfirmation(route),executionEnabled:false};}
  if(path==='/api/ibc/routes/add'){shape(b,['route','confirmation']);const r=validateIbcRoute(b.route);need(b.confirmation===routeConfirmation(r),'IBC_ROUTE_CONFIRMATION');need(!s.activeApproval&&!s.nonEvm.busy,'APPROVAL_BUSY');const next=validateSettings({...s.settings,ibcRoutes:[...(s.settings.ibcRoutes??[]),r]});s.invalidate('IBC_ROUTE_ADDED');s.vault.lock();try{s.saveSettings(next);s.settings=next;}catch(e){s.nonEvm.restartRequired=true;throw e;}return {added:true,locked:true,route:r};}
  if(path==='/api/ibc/history'){shape(b,[]);return {records:(await s.vault.nonEvmRecords()).filter(r=>r.summary.operation===IBC_OPERATION)};}
  if(path==='/api/ibc/monitor/start'){
   const options=monitorOptions(b),epoch=s.vault.epoch,generation=this.monitor.generation;need(!s.activeApproval&&!s.nonEvm.busy,'APPROVAL_BUSY');
   const records=await s.vault.nonEvmRecords();s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
   need(generation===this.monitor.generation,'IBC_MONITOR_START_INVALIDATED');
   for(const id of options.ids){const r=records.find(r=>r.id===id&&r.summary.operation===IBC_OPERATION);need(r&&r.state!=='signed','IBC_TRACKING_RECORD_INVALID');this.route(r.summary.route.id);}
   // Read-only monitoring does not refresh the inactivity deadline.
   return this.monitor.start(options);
  }
  return s.nonEvm.withOperation(async()=>{
   need(!s.activeApproval,'APPROVAL_BUSY');const epoch=s.vault.epoch,guard=()=>{s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');};
   if(path==='/api/ibc/balance'){shape(b,['accountId','routeId']);const result=await this.engine.balance(this.route(b.routeId),s.vault.account(b.accountId));guard();return result;}
   if(path==='/api/ibc/prepare'){shape(b,['accountId','routeId','payment']);s.vault.touch();const r=this.route(b.routeId),a=s.vault.account(b.accountId),u=this.engine.normalize(r,a,b.payment),records=await s.vault.nonEvmRecords();guard();const existing=records.find(v=>v.family==='cosmos'&&v.accountId===a.id&&v.summary.networkId===r.source.network.id&&v.requestKey===u.requestKey);
    if(existing){need(existing.summary.operation===IBC_OPERATION&&existing.paymentHash===this.engine.hash(r,a,u)&&existing.summary.routeFingerprint===ibcRouteFingerprint(r),'PAYMENT_KEY_CONTENT_CONFLICT');return {alreadyRecorded:true,record:existing,submittedAgain:false};}
    this.engine.unresolved(records,r,a);const intent=await this.engine.prepare(r,a,u);guard();const request=s.addRequest({kind:'ibc-transfer',origin:s.origin,sessionToken:null,intent,expiresAt:intent.expiresAt});return {id:request.id,intentId:intent.id,summary:intent.summary};
   }
   if(path==='/api/ibc/approve'){shape(b,['id','intentId','confirmation','broadcast']);need(typeof b.broadcast==='boolean','BROADCAST_FLAG_INVALID');const request=s.requests.get(b.id);need(request?.kind==='ibc-transfer'&&request.origin===s.origin&&request.sessionToken===null&&request.state==='pending'&&s.now()<request.expiresAt,'IBC_APPROVAL_NOT_PENDING');need(b.intentId===request.intent.id&&b.confirmation===request.intent.summary.confirmationText,'IBC_APPROVAL_CONFIRMATION');const r=this.route(request.intent.summary.route.id);need(!b.broadcast||r.source.network.broadcastEnabled,'BROADCAST_DISABLED');s.activeApproval=true;request.state='processing';const authorize=()=>{guard();need(request.state==='processing','REQUEST_NOT_PROCESSING');};
    try{let record=await this.engine.sign(s.vault,r,request.intent,{authorize});if(b.broadcast)record=await this.engine.broadcast(s.vault,r,record,{authorize});request.state='approved';request.recordId=record.id;request.result={record};return {approved:true,record};}catch(e){request.state='rejected';request.error=safeError(e);throw e;}finally{s.activeApproval=false;}
   }
   if(['/api/ibc/submit','/api/ibc/reconcile','/api/ibc/track','/api/ibc/relay-plan'].includes(path)){
    shape(b,path.endsWith('/submit')?['id','confirmation']:['id'],path.endsWith('/reconcile')?['destinationTxHash','settlementTxHash']:[]);
    const record=(await s.vault.nonEvmRecords()).find(r=>r.id===b.id&&r.summary.operation===IBC_OPERATION);need(record,'IBC_RECORD_NOT_FOUND');guard();const r=this.route(record.summary.route.id);
    if(path.endsWith('/submit')){need(b.confirmation===record.signed.requestId,'IBC_TXID_CONFIRMATION');s.vault.touch();return this.engine.broadcast(s.vault,r,record,{authorize:guard});}
    if(path.endsWith('/relay-plan')){need(record.report?.packet&&record.state!=='signed','IBC_PACKET_NOT_OBSERVED');return {protocol:'ibc-classic-ics20-v1',packet:clone(record.report.packet),route:clone(r),sourceTxHash:record.signed.requestId,privateKeysIncluded:false,signingAuthority:false,timeoutRequiresNonReceiptProof:true,advisoryOnly:true};}
    if(path.endsWith('/track'))return this.engine.reconcile(s.vault,r,record,{},{discover:true,authorize:guard});
    const refs={};for(const k of ['destinationTxHash','settlementTxHash'])if(b[k]!==undefined){need(typeof b[k]==='string'&&/^[A-Fa-f0-9]{64}$/.test(b[k]),'IBC_EVIDENCE_HASH');refs[k]=b[k].toUpperCase();}return this.engine.reconcile(s.vault,r,record,refs);
   }
   throw Error('NOT_FOUND');
  });
 }
}
