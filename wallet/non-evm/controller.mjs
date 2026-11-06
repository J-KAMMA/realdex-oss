import {prepareInjectiveRetirement,retireInjectiveExpired} from '../injective/retirement.mjs';
import {CosmosAuthzEngine} from './cosmos-authz-engine.mjs';
import {isAuthzOperation} from './cosmos-authz-codec.mjs';
import {CosmosEngine} from './cosmos-engine.mjs';
import {validateCosmosNetwork,cosmosNetworkFingerprint} from './cosmos-network.mjs';
import {AccountEngine} from './account-engine.mjs';
import {validateAccountNetwork,accountNetworkFingerprint} from './account-network.mjs';
import {BitcoinEngine,normalizeBitcoinOnline} from './bitcoin-engine.mjs';
import {validateBitcoinNetwork,bitcoinNetworkFingerprint,btcSatoshis} from './bitcoin-network.mjs';
import {prepareStellarOffline,signStellarOffline} from './stellar-offline.mjs';
import {prepareAptosOffline,signAptosOffline} from './aptos-offline.mjs';
import {prepareCosmosOffline,signCosmosOffline} from './cosmos-offline.mjs';
import {prepareBitcoinOffline,signBitcoinOffline} from './bitcoin-offline.mjs';
/** Owner-only extension. No agent/dapp transport or key export is added. */
import {need, shape, canonical, clone} from '../lib/guard.mjs';
import {validateSettings} from '../lib/network.mjs';
import {validateSolanaNetwork} from './solana-network.mjs';
import {SplEngine,normalizeSplPayment} from './spl-engine.mjs';
import {uint} from '../lib/guard.mjs';
import {SolanaEngine, normalizeSolanaPayment} from './solana-engine.mjs';
import {prepareIcpOffline,signIcpOffline} from './icp-offline.mjs';
import {InjectiveOwnerEngine} from '../injective/engine.mjs';
import {cancelAction,withdrawAction,depositAction,prepareOwnerAction} from '../injective/actions.mjs';
import {injectiveReviewFromSummary} from '../injective/codec.mjs';
import {actionPolicy,localActionEndpoint} from '../injective/action-codec.mjs';
export class NonEvmController {
  constructor(server,{engine=new SolanaEngine({now:server.now})}={}) {this.server=server;this.engine=engine;this.splEngine=new SplEngine({rpc:engine.rpc,now:server.now});this.bitcoinEngine=new BitcoinEngine({now:server.now});this.accountEngine=new AccountEngine({now:server.now});this.cosmosEngine=new CosmosEngine({now:server.now});this.authzEngine=new CosmosAuthzEngine({now:server.now});this.injectiveEngine=new InjectiveOwnerEngine({now:server.now});this.busy=false;this.restartRequired=false;}
  network(id) {const n=(this.server.settings.solanaNetworks??[]).find(n=>n.id===id);need(n,'SOLANA_NETWORK_NOT_CONFIGURED');return n;}
  bitcoinNetwork(id){const n=(this.server.settings.bitcoinNetworks??[]).find(n=>n.id===id);need(n,'BITCOIN_NETWORK_NOT_CONFIGURED');return n;}
  accountNetwork(id){const n=(this.server.settings.accountNetworks??[]).find(n=>n.id===id);need(n,'ACCOUNT_NETWORK_NOT_CONFIGURED');return n;}
  cosmosNetwork(id){const n=(this.server.settings.cosmosNetworks??[]).find(n=>n.id===id);need(n,'COSMOS_NETWORK_NOT_CONFIGURED');return n;}
  async withOperation(fn){need(!this.busy,'NON_EVM_OPERATION_BUSY');this.busy=true;try{return await fn();}finally{this.busy=false;}}
  async api(route,b) {
    const s=this.server;s.vault.check();need(!this.restartRequired,'NON_EVM_SETTINGS_RESTART_REQUIRED');
    if(route==='/api/non-evm/networks/add'){
      shape(b,['network','confirmation']);const n=validateSolanaNetwork(b.network);
      need(b.confirmation===`ADD ${n.id} ${n.genesisHash}`,'SOLANA_NETWORK_CONFIRMATION_REQUIRED');
      need(!s.activeApproval&&!this.busy,'APPROVAL_BUSY');need(!(s.settings.solanaNetworks??[]).some(x=>x.id===n.id),'DUPLICATE_SOLANA_NETWORK');
      const next=validateSettings({...s.settings,solanaNetworks:[...(s.settings.solanaNetworks??[]),n]});
      s.invalidate('NON_EVM_NETWORK_ADDED');s.vault.lock();
      try{s.saveSettings(next);s.settings=next;}catch(error){this.restartRequired=true;throw error;}
      return {added:true,locked:true,network:clone(n)};
    }
    if(route==='/api/non-evm/bitcoin-online/networks/add'){
      shape(b,['network','confirmation']);const n=validateBitcoinNetwork(b.network);
      need(b.confirmation===`ADD ${n.id} ${n.checkpoint.hash}`,'BITCOIN_NETWORK_CONFIRMATION_REQUIRED');
      need(!s.activeApproval&&!this.busy,'APPROVAL_BUSY');need(!(s.settings.bitcoinNetworks??[]).length,'BITCOIN_NETWORK_ALREADY_CONFIGURED');
      const next=validateSettings({...s.settings,bitcoinNetworks:[n]});s.invalidate('BITCOIN_NETWORK_ADDED');s.vault.lock();
      try{s.saveSettings(next);s.settings=next;}catch(error){this.restartRequired=true;throw error;}
      return {added:true,locked:true,network:n};
    }
    if(route==='/api/non-evm/bitcoin-online/utxos'){
      shape(b,['accountId','networkId']);return this.withOperation(async()=>{
        const epoch=s.vault.epoch,records=await s.vault.nonEvmRecords(),a=s.vault.account(b.accountId);
        const result=await this.bitcoinEngine.utxos(this.bitcoinNetwork(b.networkId),a,records);s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');return result;
      });
    }
    if(route==='/api/non-evm/bitcoin-online/prepare'){
      shape(b,['accountId','networkId','payment']);s.vault.touch();return this.withOperation(async()=>{
        const epoch=s.vault.epoch,n=this.bitcoinNetwork(b.networkId),a=s.vault.account(b.accountId);let payment=b.payment;
        if(Object.hasOwn(payment,'amount')){shape(payment,['requestKey','to','amount','feeAtomic','maxFeeRateSatVb','utxos']);need(typeof payment.amount==='string'&&/^(0|[1-9][0-9]{0,7})(\.[0-9]{1,8})?$/.test(payment.amount),'BITCOIN_AMOUNT_PRECISION');const {amount,...rest}=payment;payment={...rest,amountAtomic:btcSatoshis(amount)};}
        const p=normalizeBitcoinOnline(n,a,payment),records=await s.vault.nonEvmRecords();s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const existing=records.find(r=>r.family==='bitcoin'&&r.accountId===a.id&&r.summary.networkId===n.id&&r.requestKey===p.requestKey);
        if(existing){need(existing.paymentHash===p.paymentHash,'PAYMENT_KEY_CONTENT_CONFLICT');need(existing.summary.networkFingerprint===bitcoinNetworkFingerprint(n),'BITCOIN_RECORD_NETWORK_CHANGED');return {alreadyRecorded:true,record:existing,submittedAgain:false};}
        const outpoints=new Set(p.utxos.map(i=>i.txid+':'+i.vout));need(!records.some(r=>r.family==='bitcoin'&&r.summary.outpoints.some(o=>outpoints.has(o))),'BITCOIN_OUTPOINT_ALREADY_RESERVED');
        const intent=await this.bitcoinEngine.prepare(n,a,payment);s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const request=s.addRequest({kind:'non-evm-bitcoin-online',origin:s.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});return {id:request.id,intentId:intent.id,summary:intent.summary};
      });
    }
    if(['/api/non-evm/bitcoin-online/submit','/api/non-evm/bitcoin-online/reconcile'].includes(route)){
      shape(b,route.endsWith('/submit')?['id','confirmation']:['id']);return this.withOperation(async()=>{
        need(!s.activeApproval,'APPROVAL_BUSY');const record=(await s.vault.nonEvmRecords()).find(r=>r.id===b.id&&r.family==='bitcoin');need(record,'RECORD_NOT_FOUND');
        const n=this.bitcoinNetwork(record.summary.networkId),epoch=s.vault.epoch;
        if(route.endsWith('/reconcile'))return this.bitcoinEngine.reconcile(s.vault,n,record);
        s.vault.touch();need(b.confirmation===record.signed.requestId,'BITCOIN_TXID_CONFIRMATION_REQUIRED');
        return this.bitcoinEngine.broadcast(s.vault,n,record,{authorize:()=>{s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');}});
      });
    }
    if(route==='/api/non-evm/cosmos-authz/status'){
      shape(b,['networkId','granter','grantee']);return this.withOperation(async()=>{
        const epoch=s.vault.epoch,n=this.cosmosNetwork(b.networkId);
        const result=await this.authzEngine.status(n,b.granter,b.grantee);s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');return result;
      });
    }
    if(route==='/api/non-evm/cosmos-authz/prepare'){
      shape(b,['accountId','networkId','payment']);s.vault.touch();return this.withOperation(async()=>{
        const epoch=s.vault.epoch,n=this.cosmosNetwork(b.networkId),a=s.vault.account(b.accountId),u=this.authzEngine.normalize(n,a,b.payment),records=await s.vault.nonEvmRecords();
        s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const existing=records.find(r=>r.family==='cosmos'&&r.accountId===a.id&&r.summary.networkId===n.id&&r.requestKey===u.requestKey);
        if(existing){need(isAuthzOperation(existing.summary.operation)&&existing.paymentHash===this.authzEngine.hash(n,a,u),'PAYMENT_KEY_CONTENT_CONFLICT');need(existing.summary.networkFingerprint===cosmosNetworkFingerprint(n),'COSMOS_RECORD_NETWORK_CHANGED');return {alreadyRecorded:true,record:existing,submittedAgain:false};}
        this.authzEngine.unresolved(records,n,a);
        const intent=await this.authzEngine.prepare(n,a,u);s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const r=s.addRequest({kind:'non-evm-cosmos-authz',origin:s.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});return {id:r.id,intentId:intent.id,summary:intent.summary};
      });
    }
    if(['/api/non-evm/cosmos-authz/submit','/api/non-evm/cosmos-authz/reconcile'].includes(route)){
      const submit=route.endsWith('/submit');shape(b,submit?['id','confirmation']:['id']);
      return this.withOperation(async()=>{
        need(!s.activeApproval,'APPROVAL_BUSY');const epoch=s.vault.epoch,record=(await s.vault.nonEvmRecords()).find(r=>r.id===b.id&&r.family==='cosmos'&&isAuthzOperation(r.summary.operation));
        need(record,'RECORD_NOT_FOUND');const n=this.cosmosNetwork(record.summary.networkId);
        if(!submit)return this.authzEngine.reconcile(s.vault,n,record);
        need(b.confirmation===record.signed.requestId,'COSMOS_TXID_CONFIRMATION_REQUIRED');s.vault.touch();
        return this.authzEngine.broadcast(s.vault,n,record,{authorize:()=>{s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');}});
      });
    }
    if(route==='/api/non-evm/cosmos-online/networks/add'){
      shape(b,['network','confirmation']);const n=validateCosmosNetwork(b.network);
      need(b.confirmation===`ADD ${n.id} ${n.checkpoint.hash}`,'COSMOS_NETWORK_CONFIRMATION_REQUIRED');
      need(!s.activeApproval&&!this.busy,'APPROVAL_BUSY');
      need(!(s.settings.cosmosNetworks??[]).some(x=>x.id===n.id),'DUPLICATE_COSMOS_NETWORK');
      const next=validateSettings({...s.settings,cosmosNetworks:[...(s.settings.cosmosNetworks??[]),n]});
      s.invalidate('COSMOS_NETWORK_ADDED');s.vault.lock();
      try{s.saveSettings(next);s.settings=next;}catch(error){this.restartRequired=true;throw error;}
      return {added:true,locked:true,network:n};
    }
    if(route==='/api/non-evm/cosmos-online/balance'){
      shape(b,['accountId','networkId']);return this.withOperation(async()=>{
        const epoch=s.vault.epoch,n=this.cosmosNetwork(b.networkId),a=s.vault.account(b.accountId);
        const result=await this.cosmosEngine.balance(n,a);s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');return result;
      });
    }
    if(route==='/api/non-evm/cosmos-online/prepare'){
      shape(b,['accountId','networkId','payment']);s.vault.touch();return this.withOperation(async()=>{
        const epoch=s.vault.epoch,n=this.cosmosNetwork(b.networkId),a=s.vault.account(b.accountId),u=this.cosmosEngine.normalize(n,a,b.payment),records=await s.vault.nonEvmRecords();
        s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const existing=records.find(r=>r.family===n.family&&r.accountId===a.id&&r.summary.networkId===n.id&&r.requestKey===u.requestKey);
        if(existing){need(existing.paymentHash===this.cosmosEngine.hash(n,a,u),'PAYMENT_KEY_CONTENT_CONFLICT');need(existing.summary.networkFingerprint===cosmosNetworkFingerprint(n),'COSMOS_RECORD_NETWORK_CHANGED');return {alreadyRecorded:true,record:existing,submittedAgain:false};}
        this.cosmosEngine.unresolved(records,n,a);
        const intent=await this.cosmosEngine.prepare(n,a,u);s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const r=s.addRequest({kind:'non-evm-cosmos-online',origin:s.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});return {id:r.id,intentId:intent.id,summary:intent.summary};
      });
    }
    if(['/api/non-evm/cosmos-online/submit','/api/non-evm/cosmos-online/reconcile'].includes(route)){
      const submit=route.endsWith('/submit');shape(b,submit?['id','confirmation']:['id']);
      return this.withOperation(async()=>{
        need(!s.activeApproval,'APPROVAL_BUSY');const epoch=s.vault.epoch,record=(await s.vault.nonEvmRecords()).find(r=>r.id===b.id&&r.family==='cosmos'&&r.summary.operation==='cosmos-bank-send-online');
        need(record,'RECORD_NOT_FOUND');const n=this.cosmosNetwork(record.summary.networkId);
        if(!submit)return this.cosmosEngine.reconcile(s.vault,n,record);
        need(b.confirmation===record.signed.requestId,'COSMOS_TXID_CONFIRMATION_REQUIRED');s.vault.touch();
        return this.cosmosEngine.broadcast(s.vault,n,record,{authorize:()=>{s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');}});
      });
    }
    if(route==='/api/non-evm/account-online/networks/add'){
      shape(b,['network','confirmation']);const n=validateAccountNetwork(b.network);
      need(b.confirmation===`ADD ${n.id} ${n.checkpoint.hash}`,'ACCOUNT_NETWORK_CONFIRMATION_REQUIRED');
      need(!s.activeApproval&&!this.busy,'APPROVAL_BUSY');
      need(!(s.settings.accountNetworks??[]).some(x=>x.id===n.id),'DUPLICATE_ACCOUNT_NETWORK');
      const next=validateSettings({...s.settings,accountNetworks:[...(s.settings.accountNetworks??[]),n]});
      s.invalidate('ACCOUNT_NETWORK_ADDED');s.vault.lock();
      try{s.saveSettings(next);s.settings=next;}catch(error){this.restartRequired=true;throw error;}
      return {added:true,locked:true,network:n};
    }
    if(route==='/api/non-evm/account-online/balance'){
      shape(b,['accountId','networkId']);return this.withOperation(async()=>{
        const epoch=s.vault.epoch,n=this.accountNetwork(b.networkId),a=s.vault.account(b.accountId);
        const result=await this.accountEngine.balance(n,a);s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');return result;
      });
    }
    // Read-only. Asked when a signature was refused for a gap, so the owner can see the
    // gap and the exact range they would be accepting, instead of reading a code.
    if(route==='/api/non-evm/account-online/continuity'){
      shape(b,['accountId','networkId']);return this.withOperation(async()=>{
        const epoch=s.vault.epoch,n=this.accountNetwork(b.networkId),a=s.vault.account(b.accountId);
        const result=await this.accountEngine.continuity(s.vault,n,a);s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');return result;
      });
    }
    if(route==='/api/non-evm/account-online/prepare'){
      shape(b,['accountId','networkId','payment']);s.vault.touch();return this.withOperation(async()=>{
        const epoch=s.vault.epoch,n=this.accountNetwork(b.networkId),a=s.vault.account(b.accountId),u=this.accountEngine.normalize(n,a,b.payment),records=await s.vault.nonEvmRecords();
        s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const existing=records.find(r=>r.family===n.family&&r.accountId===a.id&&r.summary.networkId===n.id&&r.requestKey===u.requestKey);
        if(existing){need(existing.paymentHash===this.accountEngine.hash(n,a,u),'PAYMENT_KEY_CONTENT_CONFLICT');need(existing.summary.networkFingerprint===accountNetworkFingerprint(n),'ACCOUNT_RECORD_NETWORK_CHANGED');return {alreadyRecorded:true,record:existing,submittedAgain:false};}
        this.accountEngine.unresolved(records,n,a);
        const intent=await this.accountEngine.prepare(n,a,u);s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const r=s.addRequest({kind:'non-evm-account-online',origin:s.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});return {id:r.id,intentId:intent.id,summary:intent.summary};
      });
    }
    if(['/api/non-evm/account-online/submit','/api/non-evm/account-online/reconcile'].includes(route)){
      const submit=route.endsWith('/submit');shape(b,submit?['id','confirmation']:['id']);
      return this.withOperation(async()=>{
        need(!s.activeApproval,'APPROVAL_BUSY');const epoch=s.vault.epoch,record=(await s.vault.nonEvmRecords()).find(r=>r.id===b.id&&['stellar','aptos'].includes(r.family)&&r.summary.operation.endsWith('-online'));
        need(record,'RECORD_NOT_FOUND');const n=this.accountNetwork(record.summary.networkId);
        if(!submit)return this.accountEngine.reconcile(s.vault,n,record);
        need(b.confirmation===record.signed.requestId,'ACCOUNT_TXID_CONFIRMATION_REQUIRED');s.vault.touch();
        return this.accountEngine.broadcast(s.vault,n,record,{authorize:()=>{s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');}});
      });
    }
    if(['/api/non-evm/injective/cancel/prepare','/api/non-evm/injective/withdraw/prepare','/api/non-evm/injective/deposit/prepare'].includes(route)){
      const cancel=route.includes('/cancel/');shape(b,cancel?['accountId','sourceRecordId','payment']:['accountId','payment']);s.vault.touch();
      return this.withOperation(async()=>{
        need(!s.activeApproval,'APPROVAL_BUSY');const epoch=s.vault.epoch,a=s.vault.account(b.accountId);
        need(a.kind==='local'&&a.family==='evm','INJECTIVE_OWNER_ACCOUNT_REQUIRED');
        const records=await s.vault.injectiveRecords();let action,endpoint;
        if(cancel){const source=records.find(r=>r.id===b.sourceRecordId);need(source,'INJECTIVE_CANCEL_SOURCE_REQUIRED');await this.injectiveEngine.current(s.vault,source);
          action=cancelAction(source,a,b.payment);endpoint=injectiveReviewFromSummary(source.summary).endpoint;
        }else{action=(route.includes('/deposit/')?depositAction:withdrawAction)(a,b.payment);endpoint=localActionEndpoint(b.payment.endpoint);}
        const policy=actionPolicy(b.payment.policy),existing=records.find(r=>r.accountId===a.id&&r.requestKey===action.requestKey);
        if(existing){const review=injectiveReviewFromSummary(existing.summary);need(canonical(review.action??null)===canonical(action)&&canonical(review.policy)===canonical(policy)&&review.endpoint===endpoint,'PAYMENT_KEY_CONTENT_CONFLICT');return {alreadyRecorded:true,record:existing,submittedAgain:false};}
        this.injectiveEngine.unresolved(records,a);
        need(![...s.requests.values()].some(r=>r.kind==='non-evm-injective-local'&&['pending','processing'].includes(r.state)&&r.intent?.accountId===a.id),'INJECTIVE_REQUEST_ALREADY_PENDING');
        const review=await prepareOwnerAction(this.injectiveEngine,a,action,endpoint,policy);
        s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');const intent=this.injectiveEngine.prepare(a,review);
        const r=s.addRequest({kind:'non-evm-injective-local',origin:s.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});
        return {id:r.id,intentId:intent.id,summary:intent.summary,submissionEnabled:true};
      });
    }
    if(route==='/api/non-evm/injective/prepare'){
      shape(b,['accountId','review']);s.vault.touch();return this.withOperation(async()=>{
        const epoch=s.vault.epoch,a=s.vault.account(b.accountId),records=await s.vault.injectiveRecords();s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const intent=this.injectiveEngine.prepare(a,b.review),existing=records.find(r=>r.accountId===a.id&&r.requestKey===intent.payment.requestKey);
        if(existing){need(existing.paymentHash===intent.payment.paymentHash,'PAYMENT_KEY_CONTENT_CONFLICT');return {alreadyRecorded:true,record:existing,submittedAgain:false};}
        this.injectiveEngine.unresolved(records,a);need(![...s.requests.values()].some(r=>r.kind==='non-evm-injective-local'&&['pending','processing'].includes(r.state)&&r.intent?.accountId===a.id&&r.intent?.payment?.requestKey===intent.payment.requestKey),'INJECTIVE_REQUEST_ALREADY_PENDING');
        const r=s.addRequest({kind:'non-evm-injective-local',origin:s.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});return {id:r.id,intentId:intent.id,summary:intent.summary,submissionEnabled:true};
      });
    }
    if(['/api/non-evm/injective/recovery/prepare','/api/non-evm/injective/recovery/retire'].includes(route)){
      const commit=route.endsWith('/retire');shape(b,commit?['id','review','confirmation','transactionHash']:['id']);s.vault.touch();
      return this.withOperation(async()=>{
        need(!s.activeApproval,'APPROVAL_BUSY');const epoch=s.vault.epoch,record=(await s.vault.injectiveRecords()).find(r=>r.id===b.id);need(record,'RECORD_NOT_FOUND');
        const authorize=()=>{s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');};authorize();
        if(!commit)return prepareInjectiveRetirement(this.injectiveEngine,s.vault,record,{authorize});
        need(b.transactionHash===record.signed.requestId,'INJECTIVE_TXID_CONFIRMATION_REQUIRED');
        return retireInjectiveExpired(this.injectiveEngine,s.vault,record,b.review,b.confirmation,{authorize});
      });
    }
    if(['/api/non-evm/injective/submit','/api/non-evm/injective/reconcile'].includes(route)){
      const submit=route.endsWith('/submit');shape(b,submit?['id','confirmation']:['id']);return this.withOperation(async()=>{
        need(!s.activeApproval,'APPROVAL_BUSY');const epoch=s.vault.epoch,record=(await s.vault.injectiveRecords()).find(r=>r.id===b.id);need(record,'RECORD_NOT_FOUND');
        if(!submit)return this.injectiveEngine.reconcile(s.vault,record);s.vault.touch();need(b.confirmation===record.signed.requestId,'INJECTIVE_TXID_CONFIRMATION_REQUIRED');
        return this.injectiveEngine.broadcast(s.vault,record,{authorize:()=>{s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');}});
      });
    }
    if(route==='/api/non-evm/history'){shape(b,[]);const [ordinary,injective]=await Promise.all([s.vault.nonEvmRecords(),s.vault.injectiveRecords()]);return {records:[...ordinary,...injective].sort((a,b)=>a.createdAt-b.createdAt)};}
    if(route==='/api/non-evm/solana/balance'){
      shape(b,['accountId','networkId']);return this.withOperation(async()=>{
        const epoch=s.vault.epoch,result=await this.engine.balance(this.network(b.networkId),s.vault.account(b.accountId));
        s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');return result;
      });
    }
    if(route==='/api/non-evm/solana/prepare'){
      shape(b,['accountId','networkId','payment']);
      if(Object.hasOwn(b.payment,'amount')){shape(b.payment,['requestKey','to','amount']);need(typeof b.payment.amount==='string'&&/^(0|[1-9][0-9]{0,16})(\.[0-9]{1,9})?$/.test(b.payment.amount),'SOL_AMOUNT_PRECISION');const [whole,fraction='']=b.payment.amount.split('.');b={...b,payment:{requestKey:b.payment.requestKey,to:b.payment.to,lamports:String(BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0')))}};}
      s.vault.touch();return this.withOperation(async()=>{
        const epoch=s.vault.epoch,n=this.network(b.networkId),a=s.vault.account(b.accountId),p=normalizeSolanaPayment(n,a,b.payment);
        const records=await s.vault.nonEvmRecords(),existing=records.find(r=>r.accountId===a.id&&r.summary.networkId===n.id&&r.requestKey===p.requestKey);
        if(existing){need(existing.paymentHash===p.paymentHash,'PAYMENT_KEY_CONTENT_CONFLICT');return {alreadyRecorded:true,record:existing,submittedAgain:false};}
        const intent=await this.engine.prepare(n,a,b.payment);s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const request=s.addRequest({kind:'non-evm-solana',origin:s.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});
        return {id:request.id,intentId:intent.id,summary:intent.summary};
      });
    }
    if(route==='/api/non-evm/spl/accounts'){
      shape(b,['networkId','owner','mint']);return this.withOperation(async()=>{
        const epoch=s.vault.epoch,result=await this.splEngine.accounts(this.network(b.networkId),b.owner,b.mint);
        s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');return result;
      });
    }
    if(route==='/api/non-evm/spl/prepare'){
      shape(b,['accountId','networkId','payment']);s.vault.touch();return this.withOperation(async()=>{
        const epoch=s.vault.epoch,n=this.network(b.networkId),a=s.vault.account(b.accountId);
        let payment=b.payment;
        if(Object.hasOwn(payment,'amount')){
          shape(payment,['requestKey','mint','source','destination','to','amount']);const token=(n.splTokens??[]).find(t=>t.mint===payment.mint);need(token,'SPL_MINT_NOT_REGISTERED');
          need(typeof payment.amount==='string'&&/^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/.test(payment.amount),'SPL_AMOUNT_PRECISION');
          const [whole,fraction='']=payment.amount.split('.');need(fraction.length<=token.decimals,'SPL_AMOUNT_PRECISION');
          const {amount,...rest}=payment;payment={...rest,amountAtomic:String(BigInt(whole)*10n**BigInt(token.decimals)+BigInt(fraction.padEnd(token.decimals,'0')||'0'))};
        }
        const p=normalizeSplPayment(n,a,payment),records=await s.vault.nonEvmRecords();
        s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const existing=records.find(r=>r.accountId===a.id&&r.summary.networkId===n.id&&r.requestKey===p.requestKey);
        if(existing){need(existing.paymentHash===p.paymentHash,'PAYMENT_KEY_CONTENT_CONFLICT');return {alreadyRecorded:true,record:existing,submittedAgain:false};}
        const intent=await this.splEngine.prepare(n,a,payment);s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const r=s.addRequest({kind:'non-evm-spl',origin:s.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});return {id:r.id,intentId:intent.id,summary:intent.summary};
      });
    }
    if(['/api/non-evm/cosmos/prepare','/api/non-evm/bitcoin/prepare','/api/non-evm/stellar/prepare','/api/non-evm/aptos/prepare'].includes(route)){
      shape(b,['accountId','payment']);s.vault.touch();return this.withOperation(async()=>{
        const epoch=s.vault.epoch,family=route.split('/')[3];
        const prepare={cosmos:prepareCosmosOffline,bitcoin:prepareBitcoinOffline,stellar:prepareStellarOffline,aptos:prepareAptosOffline}[family],intent=prepare(s.vault.account(b.accountId),b.payment,s.now());
        const records=await s.vault.nonEvmRecords();s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
        const existing=records.find(r=>r.accountId===b.accountId&&r.summary.networkId===intent.networkId&&r.requestKey===intent.payment.requestKey);
        if(existing){need(existing.paymentHash===intent.payment.paymentHash,'PAYMENT_KEY_CONTENT_CONFLICT');return {alreadyRecorded:true,record:existing,submittedAgain:false};}
        const r=s.addRequest({kind:'non-evm-'+family,origin:s.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});return {id:r.id,intentId:intent.id,summary:intent.summary,submissionEnabled:false};
      });
    }
    if(route==='/api/non-evm/icp/prepare'){
      shape(b,['accountId','payment']);s.vault.touch();
      const intent=prepareIcpOffline(s.vault.account(b.accountId),b.payment,s.now());
      const epoch=s.vault.epoch,records=await s.vault.nonEvmRecords();s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');
      const existing=records.find(r=>r.accountId===b.accountId&&r.summary.networkId===intent.networkId&&r.requestKey===intent.payment.requestKey);
      if(existing){need(existing.paymentHash===intent.payment.paymentHash,'PAYMENT_KEY_CONTENT_CONFLICT');return {alreadyRecorded:true,record:existing,submittedAgain:false};}
      const r=s.addRequest({kind:'non-evm-icp',origin:s.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});
      return {id:r.id,intentId:intent.id,summary:intent.summary,submissionEnabled:false};
    }
    if(route==='/api/non-evm/approve'){
      // acknowledgeGap is optional and only ever consulted when this copy of the vault
      // cannot account for the account's own progress. It names the exact range being
      // accepted, so sending it speculatively with every approval buys nothing: a range
      // that does not match what was observed is refused.
      shape(b,['id','intentId','confirmation','broadcast'],['acknowledgeGap']);need(typeof b.broadcast==='boolean','BROADCAST_FLAG_INVALID');
      return this.withOperation(async()=>{
        s.vault.check();need(!s.activeApproval,'APPROVAL_BUSY');s.activeApproval=true;
        const r=s.requests.get(b.id),epoch=s.vault.epoch;
        try{
          need(r&&['non-evm-solana','non-evm-spl','non-evm-icp','non-evm-cosmos','non-evm-bitcoin','non-evm-stellar','non-evm-aptos','non-evm-bitcoin-online','non-evm-account-online','non-evm-cosmos-online','non-evm-cosmos-authz','non-evm-injective-local'].includes(r.kind)&&r.origin===s.origin&&r.sessionToken===null&&r.state==='pending','NON_EVM_REQUEST_NOT_PENDING');
          need(r.intent.id===b.intentId&&s.now()<r.expiresAt&&b.confirmation===(['non-evm-cosmos-authz','non-evm-injective-local'].includes(r.kind)?r.intent.summary.confirmationText:r.intent.summary.recipient),'TRANSACTION_CONFIRMATION_MISMATCH');
          if(['non-evm-cosmos','non-evm-bitcoin','non-evm-stellar','non-evm-aptos'].includes(r.kind))need(b.broadcast===false,'OFFLINE_SUBMISSION_NOT_IMPLEMENTED');
          if(r.kind==='non-evm-icp')need(b.broadcast===false,'ICP_SUBMISSION_NOT_IMPLEMENTED');
          if(['non-evm-solana','non-evm-spl'].includes(r.kind)&&b.broadcast)need(this.network(r.intent.networkId).broadcastEnabled,'BROADCAST_DISABLED');
          if(r.kind==='non-evm-bitcoin-online'&&b.broadcast)need(this.bitcoinNetwork(r.intent.networkId).broadcastEnabled,'BROADCAST_DISABLED');
          if(r.kind==='non-evm-account-online'&&b.broadcast)need(this.accountNetwork(r.intent.networkId).broadcastEnabled,'BROADCAST_DISABLED');
          if(['non-evm-cosmos-online','non-evm-cosmos-authz'].includes(r.kind)&&b.broadcast)need(this.cosmosNetwork(r.intent.networkId).broadcastEnabled,'BROADCAST_DISABLED');
          if(r.kind==='non-evm-injective-local')need(b.broadcast===false,'INJECTIVE_APPROVAL_STORES_BEFORE_SUBMIT');
          r.state='processing';
          const authorize=()=>{s.vault.check();need(epoch===s.vault.epoch&&r.state==='processing','LOCK_INTERRUPTED_OPERATION');};
          let record;
          if(r.kind==='non-evm-injective-local'){
            record=await this.injectiveEngine.sign(s.vault,r.intent,{authorize});
          }else if(r.kind==='non-evm-cosmos-authz'){
            const n=this.cosmosNetwork(r.intent.networkId);record=await this.authzEngine.sign(s.vault,n,r.intent,{authorize});if(b.broadcast)record=await this.authzEngine.broadcast(s.vault,n,record,{authorize});
          }else if(r.kind==='non-evm-cosmos-online'){
            const n=this.cosmosNetwork(r.intent.networkId);record=await this.cosmosEngine.sign(s.vault,n,r.intent,{authorize,acknowledgeGap:b.acknowledgeGap});if(b.broadcast)record=await this.cosmosEngine.broadcast(s.vault,n,record,{authorize});
          }else if(r.kind==='non-evm-account-online'){
            const n=this.accountNetwork(r.intent.networkId);record=await this.accountEngine.sign(s.vault,n,r.intent,{authorize,acknowledgeGap:b.acknowledgeGap});if(b.broadcast)record=await this.accountEngine.broadcast(s.vault,n,record,{authorize});
          }else if(r.kind==='non-evm-bitcoin-online'){
            const n=this.bitcoinNetwork(r.intent.networkId);record=await this.bitcoinEngine.sign(s.vault,n,r.intent,{authorize});if(b.broadcast)record=await this.bitcoinEngine.broadcast(s.vault,n,record,{authorize});
          }else if(['non-evm-solana','non-evm-spl'].includes(r.kind)){
            const engine=r.kind==='non-evm-spl'?this.splEngine:this.engine;
            const n=this.network(r.intent.networkId);record=await engine.sign(s.vault,n,r.intent,{authorize});
            if(b.broadcast)record=await engine.broadcast(s.vault,n,record,{authorize});
          }else if(r.kind==='non-evm-stellar')record=await signStellarOffline(s.vault,r.intent,{now:s.now,authorize});
          else if(r.kind==='non-evm-aptos')record=await signAptosOffline(s.vault,r.intent,{now:s.now,authorize});
          else if(r.kind==='non-evm-cosmos')record=await signCosmosOffline(s.vault,r.intent,{now:s.now,authorize});
          else if(r.kind==='non-evm-bitcoin')record=await signBitcoinOffline(s.vault,r.intent,{now:s.now,authorize});
          else record=await signIcpOffline(s.vault,r.intent,{now:s.now,authorize});
          r.state='approved';r.recordId=record.id;r.result={record};return {record,approved:true};
        }catch(error){if(r&&['pending','processing'].includes(r.state)){r.state='rejected';r.error='NON_EVM_APPROVAL_FAILED';}throw error;}
        finally{s.activeApproval=false;}
      });
    }
    if(route==='/api/non-evm/solana/submit'){
      shape(b,['id','confirmation']);return this.withOperation(async()=>{
        need(!s.activeApproval,'APPROVAL_BUSY');s.vault.touch();const epoch=s.vault.epoch;
        const record=(await s.vault.nonEvmRecords()).find(r=>r.id===b.id&&r.family==='solana');need(record,'RECORD_NOT_FOUND');
        need(b.confirmation===record.signed.signature,'SOLANA_SIGNATURE_CONFIRMATION_REQUIRED');
        return (record.summary.operation==='spl-transfer-checked'?this.splEngine:this.engine).broadcast(s.vault,this.network(record.summary.networkId),record,{authorize:()=>{s.vault.check();need(epoch===s.vault.epoch,'LOCK_INTERRUPTED_OPERATION');}});
      });
    }
    if(route==='/api/non-evm/solana/reconcile'){
      shape(b,['id']);return this.withOperation(async()=>{
        need(!s.activeApproval,'APPROVAL_BUSY');const record=(await s.vault.nonEvmRecords()).find(r=>r.id===b.id&&r.family==='solana');need(record,'RECORD_NOT_FOUND');
        return (record.summary.operation==='spl-transfer-checked'?this.splEngine:this.engine).reconcile(s.vault,this.network(record.summary.networkId),record);
      });
    }
    throw Error('NON_EVM_METHOD_UNSUPPORTED');
  }
}
