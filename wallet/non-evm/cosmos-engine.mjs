/** Owner-only Cosmos lifecycle. No automatic retry or sequence re-signing. */
import {randomUUID} from 'node:crypto';
import {keyInfo} from '../lib/keys.mjs';
import {need,clone,freeze,safeError} from '../lib/guard.mjs';
import {fingerprint} from './solana-codec.mjs';
import {CosmosRpc,validateCosmosNetwork,cosmosNetworkFingerprint,COSMOS_ASSURANCE,COSMOS_ONLINE_OPERATION} from './cosmos-network.mjs';
import {cosmosUserPayment,cosmosPaymentHash} from './cosmos-payment.mjs';
import {prepareCosmosOffline,signCosmosPayment,verifyCosmosSigned} from './cosmos-offline.mjs';
import {CosmosAdapter} from './cosmos-online.mjs';
import {compareAccountProgress,highestSignedSequence,VAULT_CONTINUITY_ACKNOWLEDGEMENT} from '../lib/vault-continuity.mjs';
const finalized=r=>['reported-confirmed','reported-reverted'].includes(r.state);
const signedFloor=(records,n,a)=>highestSignedSequence(records,{family:n.family,networkId:n.id,from:a.address});
export class CosmosEngine {
  constructor({rpc=new CosmosRpc(),now=Date.now}={}){
    this.rpc=rpc;this.now=now;this.active=new Set();this.cosmosAdapter=new CosmosAdapter(rpc,now);
  }
  adapter(n){return this.cosmosAdapter;}
  publicAccount(a){
    let secret;
    try{
      need(typeof a.secretHex==='string','COSMOS_LOCAL_SECRET_REQUIRED');
      secret=Buffer.from(a.secretHex,'hex');const info=keyInfo(a.family,secret);
      need(info.address===a.address,'COSMOS_PUBLIC_KEY_MISMATCH');
      return {id:a.id,family:a.family,kind:a.kind,address:a.address,publicKeyHex:info.publicKeyHex};
    }finally{secret?.fill(0);}
  }
  normalize(n,a,p){return cosmosUserPayment(a,p,validateCosmosNetwork(n));}
  hash(n,a,p){return cosmosPaymentHash(a,n,p);}
  async balance(network,a){const n=validateCosmosNetwork(network);need(a.family===n.family,'COSMOS_FAMILY_MISMATCH');return this.adapter(n).balance(n,a);}
  unresolved(records,n,a){
    need(!records.some(r=>r.family===n.family&&r.summary.from===a.address&&r.summary.networkId===n.id&&!finalized(r)),'COSMOS_UNRESOLVED_TRANSFER');
  }
  async prepare(network,a,raw){
    a=this.publicAccount(a);
    const n=validateCosmosNetwork(network),u=this.normalize(n,a,raw),adapter=this.adapter(n);
    const checked=await adapter.inspect(n,a,u);
    const base=prepareCosmosOffline(a,adapter.payment(n,a,u,checked),this.now());
    await adapter.inspect(n,a,u,base.payment);
    const fp=cosmosNetworkFingerprint(n),paymentHash=this.hash(n,a,u);
    const intent={...base,salt:randomUUID(),networkFingerprint:fp,userPayment:u,
      payment:{...base.payment,paymentHash},
      summary:{...base.summary,transfer:base.payment,operation:COSMOS_ONLINE_OPERATION,network:n.name,networkFingerprint:fp,cosmosNetwork:clone(n),decimals:n.decimals,feeDecimals:n.feeDecimals,assetSymbol:n.symbol,checkpoint:clone(n.checkpoint),userPayment:u,paymentHash,submissionEnabled:n.broadcastEnabled,rpcStateChecked:true,onChainStateVerified:false,finalityProven:false,assurance:COSMOS_ASSURANCE,checkedHead:checked.head}};
    delete intent.id;intent.id=fingerprint(intent);return freeze(intent);
  }
  verifyIntent(n,i){
    const {id,...content}=i;
    need(fingerprint(content)===id&&i.networkFingerprint===cosmosNetworkFingerprint(n),'COSMOS_INTENT_CHANGED');
    need(this.now()>=i.createdAt&&this.now()<i.expiresAt,'COSMOS_INTENT_EXPIRED');
  }
  async sign(vault,network,intent,{authorize=()=>{},acknowledgeGap}={}){
    const n=validateCosmosNetwork(network);this.verifyIntent(n,intent);vault.check();const epoch=vault.epoch,a=this.publicAccount(vault.account(intent.accountId));
    const guard=()=>{authorize();vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');this.verifyIntent(n,intent);};
    const records=await vault.nonEvmRecords();
    this.unresolved(records,n,a);guard();
    await this.adapter(n).inspect(n,a,intent.userPayment,intent.summary.transfer);guard();
    // The same exposure as the account families, and the same answer. A vault is a file,
    // a file can be copied, and two copies both sign without seeing each other. The
    // account's own sequence is the counter every copy can read and none can rewind, and
    // inspect() has just established the account sits one below the one about to be
    // signed. See the internal design notes (not published); the rules are shared so the two engines
    // cannot drift into disagreeing about what counts as accounted for.
    const signed=signedFloor(records,n,a);
    if(signed!==null){
      const chain=(BigInt(intent.summary.transfer.sequence)-1n).toString();
      const progress=compareAccountProgress(signed.toString(),chain);
      if(!progress.maySign){
        need(progress.status==='unaccounted-activity','COSMOS_CONTINUITY_CHAIN_BEHIND_RECORD');
        need(acknowledgeGap!==undefined,'COSMOS_UNACCOUNTED_ACTIVITY');
        need(acknowledgeGap!==null&&typeof acknowledgeGap==='object'&&!Array.isArray(acknowledgeGap),'COSMOS_GAP_ACKNOWLEDGEMENT_INVALID');
        need(acknowledgeGap.fromSequence===signed.toString()&&acknowledgeGap.toSequence===chain,'COSMOS_GAP_ACKNOWLEDGEMENT_DOES_NOT_MATCH');
        need(acknowledgeGap.acknowledgement===VAULT_CONTINUITY_ACKNOWLEDGEMENT,'COSMOS_GAP_ACKNOWLEDGEMENT_REQUIRED');
      }
    }
    guard();
    return vault.signNonEvmAndRecord(intent,secret=>{
      guard();return signCosmosPayment(secret,intent.summary.transfer);
    });
  }
  async current(vault,n,candidate){
    const r=(await vault.nonEvmRecords()).find(r=>r.id===candidate.id);
    need(r&&r.family===n.family&&r.summary.operation===COSMOS_ONLINE_OPERATION,'COSMOS_ONLINE_RECORD_REQUIRED');
    need(r.summary.networkFingerprint===cosmosNetworkFingerprint(n),'COSMOS_RECORD_NETWORK_CHANGED');
    verifyCosmosSigned(r.signed,r.summary);return r;
  }
  report(reason,extra={}){return {observedAt:this.now(),received:false,reason,assurance:COSMOS_ASSURANCE,finalityProven:false,...extra};}
  async broadcast(vault,network,candidate,{authorize=()=>{}}={}){
    const n=validateCosmosNetwork(network);need(n.broadcastEnabled,'BROADCAST_DISABLED');vault.check();const epoch=vault.epoch,key=candidate.accountId;
    need(!this.active.has(key),'COSMOS_OPERATION_BUSY');this.active.add(key);
    const guard=()=>{authorize();vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');};
    try{
      let r=await this.current(vault,n,candidate);guard();need(r.state==='signed','COSMOS_REBROADCAST_NOT_IMPLEMENTED');
      const a=this.publicAccount(vault.account(r.accountId));
      await this.adapter(n).inspect(n,a,r.summary.userPayment,r.summary.transfer);guard();
      // Recovery record is durable BEFORE real signature bytes leave this process.
      r=await vault.observeNonEvm(r,'broadcast-unknown',this.report('submission-starting'));guard();
      let state='broadcast',report=this.report('RPC-accepted-not-confirmed');
      try{await this.adapter(n).submit(n,r);}catch(e){state='broadcast-unknown';report=this.report(safeError(e));}
      guard();return vault.observeNonEvm(r,state,report);
    }finally{this.active.delete(key);}
  }
  async reconcile(vault,network,candidate){
    const n=validateCosmosNetwork(network);vault.check();const epoch=vault.epoch,r=await this.current(vault,n,candidate);
    const fallback=r.state==='signed'?'signed':'broadcast-unknown';let state=fallback,report;
    try{
      const {failed=false,...result}=await this.adapter(n).receipt(n,r);
      state=result.received?'reported-confirmed':failed?'reported-reverted':fallback;
      report=this.report(result.reason,result);
    }catch(e){report=this.report(safeError(e));}
    vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');return vault.observeNonEvm(r,state,report);
  }
}
