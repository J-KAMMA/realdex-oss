/** Native SendAuthorization lifecycle. Authority is enforced by x/authz, not this PC.
 * All queries remain unproved RPC observations; no bridge-release proof is emitted.
 */
import {need, uint, canonical, safeError} from '../lib/guard.mjs';
import {keyInfo} from '../lib/keys.mjs';
import {fieldBytes} from '../codec/protobuf.mjs';
import {CosmosRpc, validateCosmosNetwork, cosmosNetworkFingerprint, COSMOS_ASSURANCE, cosmosInt, cosmosHash, U64} from './cosmos-network.mjs';
import {CosmosAdapter} from './cosmos-online.mjs';
import {verifyCosmosInclusion} from './cosmos-proof.mjs';
import {fingerprint} from './solana-codec.mjs';
import {AUTHZ_TYPES, MAX_GRANT_SECONDS, authzUser, authzFrom, authzAddress, authzPaymentHash, authzTransaction, makeAuthzIntent, signAuthz, verifyAuthz, isAuthzOperation} from './cosmos-authz-codec.mjs';
const same=(a,b,code)=>need(canonical(a)===canonical(b),code);

export class CosmosAuthzEngine {
  constructor({rpc=new CosmosRpc(),now=Date.now}={}){this.rpc=rpc;this.now=now;this.base=new CosmosAdapter(rpc,now);this.active=new Set();}
  publicAccount(a){
    need(a.family==='cosmos'&&a.kind==='local'&&typeof a.secretHex==='string','COSMOS_LOCAL_ACCOUNT_REQUIRED');
    const b=Buffer.from(a.secretHex,'hex');try{const k=keyInfo('cosmos',b);need(k.address===a.address,'COSMOS_SIGNER_MISMATCH');return {id:a.id,family:a.family,kind:a.kind,address:a.address,publicKeyHex:k.publicKeyHex};}finally{b.fill(0);}
  }
  normalize(n,a,u){return authzUser(a,n,u);}
  hash(n,a,u){return authzPaymentHash(a,n,u);}
  unresolved(records,n,a){need(!records.some(r=>r.family==='cosmos'&&r.summary.from===a.address&&r.summary.networkId===n.id&&!['reported-confirmed','reported-reverted'].includes(r.state)),'COSMOS_UNRESOLVED_TRANSFER');}
  async grantAt(n,granter,grantee,height){
    authzAddress(granter,n.hrp);authzAddress(grantee,n.hrp);
    const query=new URLSearchParams({granter,grantee});
    return this.rpc.agree(n,i=>this.rpc.rest(n,i,'cosmos/authz/v1beta1/grants?'+query,{height}),v=>{
      need(Array.isArray(v?.grants)&&v.grants.length<=1,'AUTHZ_GRANT_RESPONSE_INVALID');
      need(!v.pagination?.next_key&&(v.pagination?.total===undefined||cosmosInt(v.pagination.total)<=1),'AUTHZ_GRANT_PAGINATION_UNSUPPORTED');
      if(v.grants.length===0)return null;
      const g=v.grants[0];need(g&&typeof g.authorization==='object'&&g.authorization!==null,'AUTHZ_GRANT_RESPONSE_INVALID');
      // Unsupported grants can be revoked, but are NEVER executed by this adapter.
      const out={kind:'unsupported',fingerprint:fingerprint(g)};
      const z=g.authorization;
      if(z['@type']!==AUTHZ_TYPES.authorization||!Array.isArray(z.spend_limit)||z.spend_limit.length!==1||!Array.isArray(z.allow_list)||z.allow_list.length!==1||typeof g.expiration!=='string')return out;
      const c=z.spend_limit[0],expiry=Date.parse(g.expiration);
      if(c.denom!==n.denom||!Number.isSafeInteger(expiry)||expiry%1000!==0||expiry<=0)return out;
      const remainingAtomic=String(uint(c.amount));need(BigInt(remainingAtomic)>0n,'AUTHZ_GRANT_RESPONSE_INVALID');
      const recipient=authzAddress(z.allow_list[0],n.hrp);
      return {...out,kind:'restricted-send',denom:c.denom,remainingAtomic,recipient,expirationSeconds:String(expiry/1000)};
    });
  }
  async status(n,granter,grantee){
    n=validateCosmosNetwork(n);const head=await this.base.head(n),grant=await this.grantAt(n,granter,grantee,head.height);
    same(await this.base.block(n,head.height),head,'COSMOS_BLOCK_CHANGED');
    return {networkId:n.id,granter,grantee,grant,head,assurance:COSMOS_ASSURANCE,finalityProven:false,
      enforcedByChain:grant?.kind==='restricted-send'?['remaining-spend-limit','denom','allowed-recipient','expiration']:[],notEnforced:['daily-limit','per-call-limit','PC-lock','owner-key-recovery'],feePayer:'transaction-signer',observationOnly:true};
  }
  async inspect(n,a,u,p=null,prior=undefined){
    const c=await this.base.balance(n,a),height=c.head.height,from=authzFrom(a,n);
    need(c.account.publicKey===null||c.account.publicKey===a.publicKeyHex,'COSMOS_AUTHENTICATION_KEY_CHANGED');
    const granter=u.action==='execute'?u.granter:from,grantee=u.action==='execute'?from:u.grantee;
    await this.base.account(n,u.action==='execute'?granter:grantee,height);
    const grant=await this.grantAt(n,granter,grantee,height);c.grant=grant;
    need(BigInt(c.account.feeBalanceAtomic)>=BigInt(u.feeAtomic),'COSMOS_INSUFFICIENT_SPENDABLE_BALANCE');
    if(u.action==='grant'){
      need(grant===null,'AUTHZ_REVOKE_BEFORE_REGRANT');
      const exp=BigInt(u.expirationSeconds),now=BigInt(Math.floor(this.now()/1000)),blockNow=BigInt(Math.floor(c.head.time/1000));
      need(exp>now+5n&&exp>blockNow+5n&&exp<=now+BigInt(MAX_GRANT_SECONDS),'AUTHZ_EXPIRATION_POLICY');
      await this.base.account(n,u.recipient,height);
    } else if(u.action==='execute'){
      need(grant?.kind==='restricted-send','AUTHZ_RESTRICTED_GRANT_REQUIRED');
      need(grant.recipient===u.recipient,'AUTHZ_RECIPIENT_NOT_ALLOWED');
      need(BigInt(grant.remainingAtomic)>=BigInt(u.amountAtomic),'AUTHZ_SPEND_LIMIT_EXCEEDED');
      need(BigInt(grant.expirationSeconds)>BigInt(Math.floor(Math.max(this.now(),c.head.time)/1000))+2n,'AUTHZ_GRANT_EXPIRED');
      if(prior!==undefined)same(grant,prior,'AUTHZ_GRANT_CHANGED');
      await this.base.account(n,u.recipient,height);
      need(BigInt(await this.base.spendable(n,granter,n.denom,height))>=BigInt(u.amountAtomic),'AUTHZ_GRANTER_BALANCE_INSUFFICIENT');
    } else need(grant!==null,'AUTHZ_GRANT_NOT_FOUND');
    if(p){
      need(c.account.sequence===p.sequence&&c.account.accountNumber===p.accountNumber,'COSMOS_SEQUENCE_OR_ACCOUNT_CHANGED');
      need(BigInt(height)<BigInt(p.timeoutHeight)&&BigInt(p.timeoutHeight)<=BigInt(height+n.timeoutBlocks),'COSMOS_TIMEOUT_HEIGHT_EXPIRED');
      const tx=authzTransaction(p,a.publicKeyHex),raw=Buffer.concat([fieldBytes(1,tx.body),fieldBytes(2,tx.auth),fieldBytes(3,Buffer.alloc(64))]);
      c.gasUsed=await this.rpc.agree(n,i=>this.rpc.rest(n,i,'cosmos/tx/v1beta1/simulate',{body:{tx_bytes:raw.toString('base64')},height}),v=>{
        const gas=String(uint(v?.gas_info?.gas_used,U64));need(BigInt(gas)>0n&&BigInt(gas)<=BigInt(p.gasLimit)&&v.result&&typeof v.result==='object','COSMOS_SIMULATION_FAILED_OR_GAS_EXCEEDED');return gas;
      });
    }
    same(await this.base.block(n,height),c.head,'COSMOS_BLOCK_CHANGED');return c;
  }
  async prepare(network,a,raw){
    const n=validateCosmosNetwork(network);a=this.publicAccount(a);const u=this.normalize(n,a,raw),c=await this.inspect(n,a,u);
    const intent=makeAuthzIntent(n,a,u,c.account,c.head,c.grant,this.now());
    await this.inspect(n,a,u,intent.payment,c.grant);return intent;
  }
  verifyIntent(n,i){const {id,...rest}=i;need(fingerprint(rest)===id&&i.networkFingerprint===cosmosNetworkFingerprint(n),'AUTHZ_INTENT_CHANGED');need(this.now()>=i.createdAt&&this.now()<i.expiresAt,'AUTHZ_INTENT_EXPIRED');}
  async sign(vault,network,i,{authorize=()=>{}}={}){
    const n=validateCosmosNetwork(network);this.verifyIntent(n,i);vault.check();const epoch=vault.epoch,a=this.publicAccount(vault.account(i.accountId));
    const guard=()=>{authorize();vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');this.verifyIntent(n,i);};
    this.unresolved(await vault.nonEvmRecords(),n,a);guard();await this.inspect(n,a,i.userPayment,i.payment,i.summary.grantBefore);guard();
    return vault.signNonEvmAndRecord(i,secret=>{guard();return signAuthz(secret,i.payment);});
  }
  async current(vault,n,candidate){
    const r=(await vault.nonEvmRecords()).find(r=>r.id===candidate.id);
    need(r?.family==='cosmos'&&isAuthzOperation(r.summary.operation),'AUTHZ_RECORD_REQUIRED');
    need(r.summary.networkFingerprint===cosmosNetworkFingerprint(n),'COSMOS_RECORD_NETWORK_CHANGED');verifyAuthz(r.signed,r.summary);return r;
  }
  report(reason,more={}){return {observedAt:this.now(),received:false,completed:false,reason,assurance:COSMOS_ASSURANCE,finalityProven:false,...more};}
  async broadcast(vault,network,candidate,{authorize=()=>{}}={}){
    const n=validateCosmosNetwork(network);need(n.broadcastEnabled,'BROADCAST_DISABLED');vault.check();const epoch=vault.epoch,key=candidate.accountId;
    need(!this.active.has(key),'AUTHZ_OPERATION_BUSY');this.active.add(key);
    const guard=()=>{authorize();vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');};
    try{
      let r=await this.current(vault,n,candidate);guard();need(r.state==='signed','AUTHZ_REBROADCAST_NOT_IMPLEMENTED');
      await this.inspect(n,this.publicAccount(vault.account(r.accountId)),r.summary.userPayment,r.summary.transfer,r.summary.grantBefore);guard();
      r=await vault.observeNonEvm(r,'broadcast-unknown',this.report('submission-starting'));guard();
      let state='broadcast',report=this.report('RPC-accepted-not-confirmed');
      try{const v=await this.rpc.rest(n,0,'cosmos/tx/v1beta1/txs',{body:{tx_bytes:r.signed.txRawBase64,mode:'BROADCAST_MODE_SYNC'}});need(cosmosHash(v?.tx_response?.txhash)===r.signed.requestId&&cosmosInt(v.tx_response.code)===0,'COSMOS_CHECKTX_NOT_ACCEPTED');}
      catch(e){state='broadcast-unknown';report=this.report(safeError(e));}
      guard();return vault.observeNonEvm(r,state,report);
    }finally{this.active.delete(key);}
  }
  async receipt(n,r){
    verifyAuthz(r.signed,r.summary);const head=await this.base.head(n),p=r.summary.transfer,raw=Buffer.from(r.signed.txRawBase64,'base64');
    const tx=await this.rpc.agree(n,i=>this.rpc.comet(n,i,'tx',{hash:Buffer.from(r.signed.requestId,'hex').toString('base64'),prove:true}),v=>{
      need(cosmosHash(v?.hash)===r.signed.requestId&&v.tx===r.signed.txRawBase64,'COSMOS_TRANSACTION_MISMATCH');
      const height=cosmosInt(v.height),index=cosmosInt(v.index),code=cosmosInt(v.tx_result?.code,0xffffffff),gasUsed=String(uint(v.tx_result?.gas_used,U64));
      need(height>=n.checkpoint.height&&height<=head.height&&BigInt(gasUsed)<=BigInt(p.gasLimit)&&Array.isArray(v.tx_result.events)&&v.tx_result.events.length<=128,'COSMOS_TX_RESULT_INVALID');return {height,index,code,gasUsed,proof:v.proof,events:v.tx_result.events};
    });
    const block=await this.base.block(n,tx.height);verifyCosmosInclusion(raw,tx.proof,block.dataHash,tx.index);
    const confirmations=head.height-tx.height+1;
    if(confirmations<n.minConfirmations)return {completed:false,received:false,reason:'confirmation-policy-not-met'};
    const evidence={height:tx.height,blockHash:block.hash,feeAtomic:p.feeAtomic,gasUsed:tx.gasUsed,code:tx.code,inclusionVerified:true,stateProofVerified:false,confirmations,requiredConfirmations:n.minConfirmations};
    if(tx.code!==0)return {...evidence,completed:false,received:false,failed:true,reason:'RPC-execution-failed'};
    const post=await this.base.account(n,p.networkFrom,tx.height);need(post.accountNumber===p.accountNumber&&BigInt(post.sequence)>=BigInt(p.sequence)+1n,'COSMOS_SEQUENCE_RESULT_MISMATCH');
    const grant=await this.grantAt(n,r.summary.granter,r.summary.grantee,tx.height);
    if(p.action==='grant')need(grant?.kind==='restricted-send'&&grant.recipient===p.recipient&&grant.remainingAtomic===p.limitAtomic&&grant.expirationSeconds===p.expirationSeconds,'AUTHZ_GRANT_RESULT_MISMATCH');
    else if(p.action==='revoke')need(grant===null,'AUTHZ_REVOKE_RESULT_MISMATCH');
    else{
      const remaining=BigInt(r.summary.grantBefore.remainingAtomic)-BigInt(p.amountAtomic);
      need(remaining===0n?grant===null:grant?.kind==='restricted-send'&&grant.remainingAtomic===String(remaining)&&grant.recipient===p.recipient&&grant.expirationSeconds===r.summary.grantBefore.expirationSeconds,'AUTHZ_SPEND_RESULT_MISMATCH');
      const matches=tx.events.filter(e=>e.type==='transfer').filter(e=>{
        need(Array.isArray(e.attributes)&&e.attributes.length<=16,'COSMOS_EVENT_INVALID');const a=Object.create(null);
        for(const x of e.attributes){need(typeof x.key==='string'&&x.key.length<=100&&typeof x.value==='string'&&x.value.length<=256&&!Object.hasOwn(a,x.key),'COSMOS_EVENT_INVALID');a[x.key]=x.value;}
        return a.sender===p.granter&&a.recipient===p.recipient&&a.amount===p.amountAtomic+p.denom;
      });need(matches.length===1,'COSMOS_TRANSFER_EVENT_MISMATCH');
    }
    same(await this.base.block(n,tx.height),block,'COSMOS_BLOCK_CHANGED');
    return {...evidence,completed:true,received:p.action==='execute',authorizationStateObserved:true,grantFingerprintAfter:grant?.fingerprint??null,reason:'RPC-reported-authorization-effect-and-inclusion'};
  }
  async reconcile(vault,network,candidate){
    const n=validateCosmosNetwork(network);vault.check();const epoch=vault.epoch,r=await this.current(vault,n,candidate),fallback=r.state==='signed'?'signed':'broadcast-unknown';let state=fallback,report;
    try{const {failed=false,...v}=await this.receipt(n,r);state=v.completed?'reported-confirmed':failed?'reported-reverted':fallback;report=this.report(v.reason,v);}catch(e){report=this.report(safeError(e));}
    vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');return vault.observeNonEvm(r,state,report);
  }
}
