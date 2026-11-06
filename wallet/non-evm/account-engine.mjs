/** Stateful owner-only online native transfers. Persist before first network submission. */
import {randomUUID} from 'node:crypto';
import {keyInfo} from '../lib/keys.mjs';
import {need,clone,freeze,canonical,safeError} from '../lib/guard.mjs';
import {fingerprint} from './solana-codec.mjs';
import {AccountRest,validateAccountNetwork,accountNetworkFingerprint,ACCOUNT_ASSURANCE,onlineOperation} from './account-network.mjs';
import {normalizeAccountUser,accountPaymentHash} from './account-payment.mjs';
import {prepareStellarOffline,signStellarPayment,verifyStellarSigned} from './stellar-offline.mjs';
import {prepareAptosOffline,signAptosPayment,verifyAptosSigned} from './aptos-offline.mjs';
import {StellarAdapter} from './stellar-online.mjs';
import {AptosAdapter} from './aptos-online.mjs';
import {compareAccountProgress,highestSignedSequence,VAULT_BACKUP_POLICY,VAULT_CONTINUITY_ACKNOWLEDGEMENT} from '../lib/vault-continuity.mjs';
const finalized=r=>['reported-confirmed','reported-reverted'].includes(r.state);
const signedFloor=(records,n,a)=>highestSignedSequence(records,{family:n.family,networkId:n.id,from:a.address});
export class AccountEngine {
  constructor({rest=new AccountRest(),now=Date.now}={}){
    this.rest=rest;this.now=now;this.active=new Set();
    this.adapters={stellar:new StellarAdapter(rest,now),aptos:new AptosAdapter(rest,now)};
  }
  adapter(n){return this.adapters[n.family];}
  publicAccount(a){
    let secret;
    try{
      need(typeof a.secretHex==='string','ACCOUNT_LOCAL_SECRET_REQUIRED');
      secret=Buffer.from(a.secretHex,'hex');const info=keyInfo(a.family,secret);
      need(info.address===a.address,'ACCOUNT_PUBLIC_KEY_MISMATCH');
      return {id:a.id,family:a.family,kind:a.kind,address:a.address,publicKeyHex:info.publicKeyHex};
    }finally{secret?.fill(0);}
  }
  normalize(n,a,p){return normalizeAccountUser(n,a,p);}
  hash(n,a,p){return accountPaymentHash(n.family,a.id,a.address,n.id,accountNetworkFingerprint(n),p);}
  async balance(network,a){const n=validateAccountNetwork(network);need(a.family===n.family,'ACCOUNT_FAMILY_MISMATCH');return this.adapter(n).balance(n,a);}
  /**
   * What this copy can and cannot account for, asked without signing anything.
   *
   * sign() refuses with a code, and a code alone leaves the owner with no way to see the
   * gap or to say which range they are accepting. Rather than smuggling the numbers out
   * through an error — safeError() reduces errors to codes on purpose — this is a
   * read-only question anyone can ask at any time.
   *
   * When there is a gap it hands back the exact acknowledgement that would let a
   * signature through, so the owner is affirming a specific range they can see rather
   * than composing one from a document.
   */
  async continuity(vault,network,accountRef){
    const n=validateAccountNetwork(network),a=this.publicAccount(accountRef);
    const records=await vault.nonEvmRecords();
    const signed=signedFloor(records,n,a);
    const {account}=await this.adapter(n).balance(n,a);
    const chain=account.sequence;
    if(signed===null)return {status:'nothing-recorded',accountSequence:chain,signedSequences:0,maySign:true,policy:VAULT_BACKUP_POLICY,
      notice:'This copy has signed nothing for this account, so there is nothing to compare against. A copy with no history cannot notice history it is missing.'};
    const progress=compareAccountProgress(signed.toString(),chain);
    // The policy travels with the answer. Rules about backups are needed exactly when
    // somebody is looking at a gap, and text that lives only in a document is text the
    // person in front of the gap does not have.
    return {...progress,accountSequence:chain,sequenceFloor:signed.toString(),policy:VAULT_BACKUP_POLICY,
      signedSequences:records.filter(r=>r.family===n.family&&r.summary?.networkId===n.id&&r.summary?.from===a.address).length,
      ...(progress.status==='unaccounted-activity'?{acknowledgeGap:{fromSequence:signed.toString(),toSequence:chain,acknowledgement:VAULT_CONTINUITY_ACKNOWLEDGEMENT}}:{}),
      ...(progress.status==='unaccounted-activity'?{notice:'Transactions were signed for this account that this copy has no record of. That may be a restored backup, a second copy in use, or you signing from another tool. Nothing here can tell which. Establish what it was before accepting the range above.'}:{}),
      ...(progress.status==='impossible-rewind'?{notice:'The account is further back than this copy has already signed for. An account sequence does not decrease, so either this is not the account this copy signed for, or the endpoint answering is serving an old state. There is no range to accept here.'}:{})};
  }
  unresolved(records,n,a){
    need(!records.some(r=>r.family===n.family&&r.summary.from===a.address&&r.summary.networkId===n.id&&!finalized(r)),'ACCOUNT_UNRESOLVED_TRANSFER');
  }
  async prepare(network,a,raw){
    a=this.publicAccount(a);
    const n=validateAccountNetwork(network),u=this.normalize(n,a,raw),adapter=this.adapter(n);
    const checked=await adapter.inspect(n,a,u);
    const base=(n.family==='stellar'?prepareStellarOffline:prepareAptosOffline)(a,adapter.payment(n,a,u,checked),this.now());
    if(n.family==='aptos')await adapter.inspect(n,a,u,base.payment);
    const fp=accountNetworkFingerprint(n),paymentHash=this.hash(n,a,u);
    const intent={...base,salt:randomUUID(),networkFingerprint:fp,userPayment:u,
      payment:{...base.payment,paymentHash},
      summary:{...base.summary,transfer:base.payment,operation:onlineOperation(n.family),network:n.name,networkFingerprint:fp,checkpoint:clone(n.checkpoint),userPayment:u,paymentHash,submissionEnabled:n.broadcastEnabled,rpcStateChecked:true,onChainStateVerified:false,finalityProven:false,assurance:ACCOUNT_ASSURANCE,checkedHead:checked.head}};
    delete intent.id;intent.id=fingerprint(intent);return freeze(intent);
  }
  verifyIntent(n,i){
    const {id,...content}=i;
    need(fingerprint(content)===id&&i.networkFingerprint===accountNetworkFingerprint(n),'ACCOUNT_INTENT_CHANGED');
    need(this.now()>=i.createdAt&&this.now()<i.expiresAt,'ACCOUNT_INTENT_EXPIRED');
  }
  async sign(vault,network,intent,{authorize=()=>{},acknowledgeGap}={}){
    const n=validateAccountNetwork(network);this.verifyIntent(n,intent);vault.check();const epoch=vault.epoch,a=this.publicAccount(vault.account(intent.accountId));
    const guard=()=>{authorize();vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');this.verifyIntent(n,intent);};
    const records=await vault.nonEvmRecords();
    this.unresolved(records,n,a);guard();
    await this.adapter(n).inspect(n,a,intent.userPayment,intent.summary.transfer);guard();
    // inspect() has just established that the account's sequence is one below the one
    // about to be signed. Compared against the highest this copy signed, that says
    // whether anything else has moved the account since — a restored backup, a second
    // copy, or the owner using a different tool. Which of those it was cannot be
    // established here and is not guessed at; what is refused is signing on top of a
    // history this copy cannot account for.
    //
    // Skipped when this copy has signed nothing: there is nothing to compare against, and
    // a fresh install on a funded account is the ordinary case, not a finding.
    const signed=signedFloor(records,n,a);
    if(signed!==null){
      const chain=(BigInt(intent.summary.transfer.sequence)-1n).toString();
      const progress=compareAccountProgress(signed.toString(),chain);
      if(!progress.maySign){
        // No way past a rewind. An account sequence does not decrease, so this is a
        // different account, a different network, or an endpoint serving an old state,
        // and none of those is something an owner can accept their way out of.
        need(progress.status==='unaccounted-activity','ACCOUNT_CONTINUITY_CHAIN_BEHIND_RECORD');
        // There has to be a way forward, or this refusal is worse than what it prevents:
        // an owner whose account was moved by another tool could never sign with this
        // copy again. The way forward names the exact range being accepted — from the
        // last sequence this copy signed to where the account actually is — so it is a
        // statement about a specific gap rather than a flag that means "stop asking".
        //
        // Nothing needs to be stored. The records afterwards show the jump from one
        // sequence to the next one signed, so that a gap was crossed stays visible in
        // the same place everything else about this copy's history is.
        need(acknowledgeGap!==undefined,'ACCOUNT_UNACCOUNTED_ACTIVITY');
        need(acknowledgeGap!==null&&typeof acknowledgeGap==='object'&&!Array.isArray(acknowledgeGap),'ACCOUNT_GAP_ACKNOWLEDGEMENT_INVALID');
        need(acknowledgeGap.fromSequence===signed.toString()&&acknowledgeGap.toSequence===chain,'ACCOUNT_GAP_ACKNOWLEDGEMENT_DOES_NOT_MATCH');
        need(acknowledgeGap.acknowledgement===VAULT_CONTINUITY_ACKNOWLEDGEMENT,'ACCOUNT_GAP_ACKNOWLEDGEMENT_REQUIRED');
      }
    }
    guard();
    return vault.signNonEvmAndRecord(intent,secret=>{
      guard();return (n.family==='stellar'?signStellarPayment:signAptosPayment)(secret,intent.summary.transfer);
    });
  }
  async current(vault,n,candidate){
    const r=(await vault.nonEvmRecords()).find(r=>r.id===candidate.id);
    need(r&&r.family===n.family&&r.summary.operation===onlineOperation(n.family),'ACCOUNT_ONLINE_RECORD_REQUIRED');
    need(r.summary.networkFingerprint===accountNetworkFingerprint(n),'ACCOUNT_RECORD_NETWORK_CHANGED');
    (n.family==='stellar'?verifyStellarSigned:verifyAptosSigned)(r.signed,r.summary);return r;
  }
  report(reason,extra={}){return {observedAt:this.now(),received:false,reason,assurance:ACCOUNT_ASSURANCE,finalityProven:false,...extra};}
  async broadcast(vault,network,candidate,{authorize=()=>{}}={}){
    const n=validateAccountNetwork(network);need(n.broadcastEnabled,'BROADCAST_DISABLED');vault.check();const epoch=vault.epoch,key=candidate.accountId;
    need(!this.active.has(key),'ACCOUNT_OPERATION_BUSY');this.active.add(key);
    const guard=()=>{authorize();vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');};
    try{
      let r=await this.current(vault,n,candidate);guard();need(r.state==='signed','ACCOUNT_REBROADCAST_NOT_IMPLEMENTED');
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
    const n=validateAccountNetwork(network);vault.check();const epoch=vault.epoch,r=await this.current(vault,n,candidate);
    const fallback=r.state==='signed'?'signed':'broadcast-unknown';let state=fallback,report;
    try{
      const {failed=false,...result}=await this.adapter(n).receipt(n,r);
      state=result.received?'reported-confirmed':failed?'reported-reverted':fallback;
      report=this.report(result.reason,result);
    }catch(e){report=this.report(safeError(e));}
    vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');return vault.observeNonEvm(r,state,report);
  }
}
