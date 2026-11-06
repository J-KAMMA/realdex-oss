/** All routes are under the owner-authenticated /api/ namespace. No agent/dapp capabilities are added. */
import {randomUUID} from 'node:crypto';
import {need,shape,text,canonical,clone,uint,hex} from '../lib/guard.mjs';
import {address,keccak256} from '../../node/verified/keccak.mjs';
import {sha256} from '../lib/keys.mjs';
import {SmartEngine} from './engine.mjs';
import {BUILD,validateMessage,normalizeDescriptor,predictAddress,messageDigest,signMessage,signatureCall} from './codec.mjs';
const hash=x=>sha256(Buffer.from(canonical(x))).toString('hex');
export class SmartController {
  constructor(wallet){this.wallet=wallet;this.engine=new SmartEngine(wallet);this.drafts=new Map();}
  invalidate(){this.drafts.clear();}
  get vault(){return this.wallet.vault;}
  list(){this.vault.check();return clone(this.vault.data.smartAccounts??[]);}
  descriptor(id){const d=this.list().find(d=>d.id===id);need(d,'SMART_ACCOUNT_NOT_REGISTERED');return d;}
  async api(route,b){
    this.vault.check();const w=this.wallet,epoch=this.vault.epoch;
    const check=()=>{need(epoch===this.vault.epoch,'WALLET_LOCKED_DURING_RECHECK');this.vault.check();};
    if(route==='/api/smart/catalog'){
      shape(b,[]);return {accounts:this.list(),keyAccounts:this.vault.publicAccounts().filter(a=>a.family==='evm'&&a.kind==='local'),
        networks:w.settings.networks.map(n=>({chainId:n.chainId,name:n.name,symbol:n.symbol,tokens:n.contracts.filter(c=>c.kind==='erc20')})),
        compiler:BUILD.compiler,experimentalOnly:BUILD.experimentalOnly,productionReady:false,
        features:{create2:true,atomicBatch:true,atomicApproveSwapRevoke:true,erc1271:true,onchainSessionBudgets:true,erc4337:false,eip7702:false,paymaster:false,passkeys:false,multisig:false,guardianRecovery:false,aiMcpSessionSigning:false}};
    }
    if(route==='/api/smart/register/prepare'){
      shape(b,['ownerAccountId','chainId','factory','salt','label']);text(b.label);hex(b.salt,32);
      for(const [id,d] of this.drafts)if(d.expiresAt<=w.now()||d.epoch!==epoch)this.drafts.delete(id);
      need(this.drafts.size<8,'SMART_DRAFT_LIMIT');const owner=this.vault.account(b.ownerAccountId),n=w.network(b.chainId);
      need(owner.kind==='local'&&owner.family==='evm','SMART_OWNER_REQUIRED');
      const descriptor=normalizeDescriptor({id:randomUUID(),ownerAccountId:owner.id,chainId:n.chainId,genesisHash:n.genesisHash,factory:address(b.factory),salt:b.salt.toLowerCase(),label:b.label,address:predictAddress(b.factory,owner.address,b.salt)});
      need(!this.list().some(d=>d.chainId===descriptor.chainId&&d.address===descriptor.address),'SMART_DUPLICATE_ACCOUNT');
      const inspected=await this.engine.inspect(n,descriptor,owner);check();
      const draft={id:randomUUID(),descriptor,digest:hash(descriptor),epoch,settingsHash:hash(n),expiresAt:w.now()+90000};this.drafts.set(draft.id,draft);
      return {draftId:draft.id,digest:draft.digest,descriptor,owner:owner.address,deployed:inspected.deployed,expiresAt:draft.expiresAt,confirmation:`REGISTER ${descriptor.address}`,factoryMatchedBundledBuild:true,independentAudit:false,requiresNewBackup:true};
    }
    if(route==='/api/smart/register/commit'){
      shape(b,['draftId','digest','confirm']);const d=this.drafts.get(b.draftId);need(d&&d.epoch===epoch&&w.now()<d.expiresAt&&d.digest===b.digest,'SMART_REGISTRATION_EXPIRED');need(b.confirm===`REGISTER ${d.descriptor.address}`,'SMART_REGISTRATION_CONFIRMATION_REQUIRED');
      const n=w.network(d.descriptor.chainId);need(hash(n)===d.settingsHash,'NETWORK_SETTINGS_CHANGED');await this.engine.inspect(n,d.descriptor,this.vault.account(d.descriptor.ownerAccountId));check();
      const result=await this.vault.addSmartAccount(d.descriptor);check();this.drafts.delete(d.id);return {registered:result,backupRequired:true};
    }
    if(route==='/api/smart/inspect'){
      shape(b,['id'],['sessionAccountId']);const d=this.descriptor(b.id),n=w.network(d.chainId),out=await this.engine.inspect(n,d,this.vault.account(d.ownerAccountId));
      if(b.sessionAccountId!==undefined){need(out.deployed,'SMART_NOT_DEPLOYED');const a=this.vault.account(b.sessionAccountId);need(a.family==='evm','SMART_SESSION_KEY_REQUIRED');out.session=await this.engine.session(n,d,a.address,out.block.ref);}
      check();return out;
    }
    if(route==='/api/smart/prepare'){
      shape(b,['id','operation']);const d=this.descriptor(b.id),intent=await this.engine.prepare(d,b.operation);check();
      const r=w.addRequest({kind:'smart-transaction',origin:w.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});return {id:r.id,intentId:intent.id,summary:clone(intent.summary)};
    }
    if(route==='/api/smart/message/prepare'){
      shape(b,['id','message','validUntil']);validateMessage(b.message);const until=uint(b.validUntil),now=BigInt(Math.floor(w.now()/1000));need(until>now&&until<=now+3600n,'SMART_MESSAGE_EXPIRY_INVALID');
      const d=this.descriptor(b.id),n=w.network(d.chainId),owner=this.vault.account(d.ownerAccountId),view=await this.engine.inspect(n,d,owner);check();need(view.deployed,'SMART_NOT_DEPLOYED');
      const payloadHash=keccak256(Buffer.from(b.message)),digest=messageDigest(d.chainId,d.address,payloadHash,b.validUntil,view.signatureEpoch);
      const message={id:randomUUID(),smartAccountId:d.id,hash:payloadHash,message:b.message,validUntil:b.validUntil,epoch:view.signatureEpoch,digest};
      const intent={id:hash(message),accountId:owner.id,message,descriptor:d,settingsHash:hash(n),expiresAt:Math.min(w.now()+90000,Number(until)*1000),summary:{operation:'smart-account-message',recipient:d.address,network:n.name,chainId:n.chainId,message:b.message,hash:payloadHash,digest,epoch:view.signatureEpoch,validUntil:b.validUntil}};
      const r=w.addRequest({kind:'smart-message',origin:w.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});return {id:r.id,intentId:intent.id,summary:clone(intent.summary)};
    }
    if(route==='/api/smart/messages'){shape(b,[]);return {messages:clone(this.vault.data.smartMessages??[])};}
    if(route==='/api/smart/message/verify'){
      shape(b,['messageId']);const m=(this.vault.data.smartMessages??[]).find(m=>m.id===b.messageId);need(m,'SMART_MESSAGE_NOT_FOUND');const d=this.descriptor(m.smartAccountId),n=w.network(d.chainId),view=await this.engine.inspect(n,d,this.vault.account(d.ownerAccountId));need(view.deployed,'SMART_NOT_DEPLOYED');
      const result=await this.engine.rpc.agree(n,'eth_call',[{to:d.address,data:signatureCall(m.hash,m.signature)},view.block.ref]);check();
      return {valid:result==='0x1626ba7e'+'0'.repeat(56),observedAt:w.now(),account:d.address,chainId:d.chainId,certificateVerified:false,assurance:'Pinned contract evaluated by the configured RPCs'};
    }
    throw Error('NOT_FOUND');
  }
  async approveRequest(r,b){
    const w=this.wallet,v=this.vault,epoch=v.epoch;need(b.intentId===r.intent.id&&b.confirm===r.intent.summary.recipient,'TRANSACTION_CONFIRMATION_MISMATCH');
    const guard=()=>{need(v.epoch===epoch&&r.state==='processing','SMART_APPROVAL_INVALIDATED');v.check();};
    if(r.kind==='smart-message'){
      need(b.broadcast!==true,'SMART_MESSAGE_NOT_TRANSACTION');const i=r.intent,n=w.network(i.descriptor.chainId);need(hash(n)===i.settingsHash,'NETWORK_SETTINGS_CHANGED');
      const view=await this.engine.inspect(n,i.descriptor,v.account(i.accountId));guard();need(view.deployed&&view.signatureEpoch===i.message.epoch&&w.now()<i.expiresAt,'SMART_MESSAGE_STALE');
      const result=await v.signSmartMessage(i,secret=>{guard();need(w.now()<i.expiresAt,'APPROVAL_EXPIRED');return signMessage(secret,i.message.digest,i.message.validUntil,i.message.epoch);});
      r.state='approved';r.result=result;return {approved:true,message:result,contractVerificationRequired:true};
    }
    need(r.kind==='smart-transaction','SMART_REQUEST_INVALID');
    const n=w.network(r.intent.networkId);need(b.broadcast!==true||n.broadcastEnabled,'BROADCAST_DISABLED');
    const record=await this.engine.sign(r.intent,guard),result=b.broadcast===true?await this.engine.broadcast(record,guard):record;
    r.state='approved';r.recordId=record.id;r.result={record:result,transactionHash:record.signed.transactionHash};
    return {approved:true,result:clone(r.result),broadcastState:result.state};
  }
}
