/** Regtest online P2WPKH adapter. Never RPC-signs, auto-replaces, or releases UTXO reservations. */
import {randomUUID} from 'node:crypto';
import {need,shape,canonical,clone,freeze,safeError} from '../lib/guard.mjs';
import {decodeWitnessAddress} from '../codec/bech32.mjs';
import {fingerprint} from './solana-codec.mjs';
import {prepareBitcoinOffline,normalizeBitcoinPayment,signBitcoinPayment,verifyBitcoinSigned} from './bitcoin-offline.mjs';
import {BitcoinRpc,validateBitcoinNetwork,bitcoinNetworkFingerprint,bitcoinHash,rpcInteger,btcSatoshis,satoshisBtc} from './bitcoin-network.mjs';
import {parseBitcoinTransaction,verifyBitcoinBlockMembership} from './bitcoin-codec.mjs';
const assurance='local-RPC-observation; header-and-merkle-binding-only; not-consensus-or-finality-proof';
export function normalizeBitcoinOnline(n,a,raw){
  shape(raw,['requestKey','to','amountAtomic','feeAtomic','maxFeeRateSatVb','utxos']);
  const p=normalizeBitcoinPayment(a,{...raw,networkId:n.id,acknowledgeUnverifiedState:true});
  need(BigInt(p.amountAtomic)<=BigInt(n.maxTransferSats)&&BigInt(p.feeAtomic)<=BigInt(n.maxFeeSats)&&BigInt(p.maxFeeRateSatVb)<=BigInt(n.maxFeeRateSatVb),'BITCOIN_NETWORK_CAP_EXCEEDED');return p;
}
export class BitcoinEngine {
  constructor({rpc=new BitcoinRpc(),now=Date.now}={}){this.rpc=rpc;this.now=now;this.active=new Set();}
  async snapshot(n){
    const roots=await this.rpc.all(n,'getblockhash',[0]);need(roots.every(x=>x===n.genesisHash),'BITCOIN_GENESIS_MISMATCH');
    const anchors=await this.rpc.all(n,'getblockhash',[n.checkpoint.height]);need(anchors.every(x=>x===n.checkpoint.hash),'BITCOIN_CHECKPOINT_MISMATCH');
    const infos=await this.rpc.all(n,'getblockchaininfo',[]);
    const heads=infos.map(i=>{need(i&&i.chain==='regtest'&&i.initialblockdownload===false&&i.pruned===false,'BITCOIN_NODE_NOT_READY');const height=rpcInteger(i.blocks,2147483647);need(rpcInteger(i.headers,2147483647)>=height&&height>=n.checkpoint.height,'BITCOIN_CHAIN_HEIGHT_INVALID');return {height,hash:bitcoinHash(i.bestblockhash)};});
    need(heads.every(x=>canonical(x)===canonical(heads[0])),'BITCOIN_RPC_TIP_DISAGREEMENT');
    const indexed=await this.rpc.all(n,'getindexinfo',['txindex']);need(indexed.every(x=>x?.txindex?.synced===true&&rpcInteger(x.txindex.best_block_height)>=heads[0].height),'BITCOIN_TXINDEX_REQUIRED');
    const hashes=await this.rpc.all(n,'getblockhash',[heads[0].height]);need(hashes.every(h=>h===heads[0].hash),'BITCOIN_SNAPSHOT_CHANGED');return heads[0];
  }
  async stable(n,snapshot){const next=await this.snapshot(n);need(canonical(next)===canonical(snapshot),'BITCOIN_SNAPSHOT_CHANGED');}
  async inspect(n,p){
    const head=await this.snapshot(n);const observations=[];
    for(const input of p.utxos){
      const values=await this.rpc.all(n,'gettxout',[input.txid,input.vout,true]);
      for(const v of values){need(v!==null,'BITCOIN_INPUT_SPENT_OR_MISSING');need(v&&typeof v.coinbase==='boolean'&&v.bestblock===head.hash,'BITCOIN_UTXO_SNAPSHOT_MISMATCH');
        const conf=rpcInteger(v.confirmations,2147483647);need(conf>=n.minConfirmations,'BITCOIN_INPUT_UNCONFIRMED');need(!v.coinbase||conf>=101,'BITCOIN_IMMATURE_COINBASE');
        need(btcSatoshis(v.value)===input.amountAtomic&&v.scriptPubKey?.hex===input.scriptHex,'BITCOIN_UTXO_CONTENT_MISMATCH');}
      const view=values.map(v=>({confirmations:rpcInteger(v.confirmations),coinbase:v.coinbase,value:btcSatoshis(v.value),script:v.scriptPubKey.hex}));
      need(view.every(x=>canonical(x)===canonical(view[0])),'BITCOIN_RPC_DISAGREEMENT');
      // Funding bytes independently bind the amount/script to the reviewed outpoint.
      const funding=await this.rpc.all(n,'getrawtransaction',[input.txid,false]);
      for(const raw of funding){const tx=parseBitcoinTransaction(raw);need(tx.txid===input.txid&&canonical(tx.outputs[input.vout]??null)===canonical({amountAtomic:input.amountAtomic,scriptHex:input.scriptHex}),'BITCOIN_FUNDING_TRANSACTION_MISMATCH');}
      observations.push({outpoint:input.txid+':'+input.vout,...view[0]});
    }
    await this.stable(n,head);return {head,inputs:observations};
  }
  async utxos(network,account,records=[]){
    const n=validateBitcoinNetwork(network);need(account.family==='bitcoin','BITCOIN_ACCOUNT_REQUIRED');decodeWitnessAddress(account.address,'bcrt');
    const head=await this.snapshot(n),scans=[];
    // Core permits only one UTXO scan at a time. Aliased endpoints must not race it.
    for(let i=0;i<n.rpcUrls.length;i++)scans.push(await this.rpc.call(n,i,'scantxoutset',['start',[`addr(${account.address})`]]));
    const reserved=new Set(records.filter(r=>r.family==='bitcoin').flatMap(r=>r.summary.outpoints));
    const projected=scans.map(s=>{need(s?.success===true&&s.bestblock===head.hash&&rpcInteger(s.height)===head.height&&Array.isArray(s.unspents)&&s.unspents.length<=512,'BITCOIN_SCAN_INVALID_OR_CHANGED');
      const result=s.unspents.map(u=>{bitcoinHash(u.txid);const vout=rpcInteger(u.vout,0xffffffff),height=rpcInteger(u.height,head.height),amountAtomic=btcSatoshis(u.amount);return {txid:u.txid,vout,amountAtomic,scriptHex:u.scriptPubKey,height};}).sort((a,b)=>a.txid.localeCompare(b.txid)||a.vout-b.vout);
      need(new Set(result.map(u=>u.txid+':'+u.vout)).size===result.length,'BITCOIN_SCAN_DUPLICATE');return result;});
    need(projected.every(x=>canonical(x)===canonical(projected[0])),'BITCOIN_RPC_DISAGREEMENT');
    const expectedScript='0014'+decodeWitnessAddress(account.address,'bcrt').toString('hex'),items=[];
    for(const u of projected[0]){
      need(u.scriptHex===expectedScript,'BITCOIN_SCAN_WRONG_OWNER');const values=await this.rpc.all(n,'gettxout',[u.txid,u.vout,true]);
      const views=values.map(v=>{if(v===null)return null;need(typeof v.coinbase==='boolean'&&v.bestblock===head.hash&&btcSatoshis(v.value)===u.amountAtomic&&v.scriptPubKey?.hex===u.scriptHex,'BITCOIN_UTXO_CONTENT_MISMATCH');return {confirmations:rpcInteger(v.confirmations),coinbase:v.coinbase};});
      need(views.every(x=>canonical(x)===canonical(views[0])),'BITCOIN_RPC_DISAGREEMENT');const v=views[0],isReserved=reserved.has(u.txid+':'+u.vout);
      const eligible=!!v&&!isReserved&&v.confirmations>=n.minConfirmations&&(!v.coinbase||v.confirmations>=101);
      items.push({...u,confirmations:v?.confirmations??0,coinbase:v?.coinbase??false,reserved:isReserved,eligible,spentInMempool:v===null});
    }
    await this.stable(n,head);return {networkId:n.id,address:account.address,head,utxos:items,totalConfirmedSats:String(items.filter(u=>!u.spentInMempool).reduce((a,u)=>a+BigInt(u.amountAtomic),0n)),eligibleSats:String(items.filter(u=>u.eligible).reduce((a,u)=>a+BigInt(u.amountAtomic),0n)),assurance,observedAt:this.now()};
  }
  async prepare(network,account,raw){
    const n=validateBitcoinNetwork(network),payment=normalizeBitcoinOnline(n,account,raw),checked=await this.inspect(n,payment);
    const base=prepareBitcoinOffline(account,{...raw,networkId:n.id,acknowledgeUnverifiedState:true},this.now());
    const intent={...base,salt:randomUUID(),networkFingerprint:bitcoinNetworkFingerprint(n),checked,summary:{...base.summary,operation:'bitcoin-p2wpkh-online',network:n.name,genesisHash:n.genesisHash,checkpoint:clone(n.checkpoint),networkFingerprint:bitcoinNetworkFingerprint(n),submissionEnabled:n.broadcastEnabled,onChainStateVerified:false,rpcInputsChecked:true,assurance,checkedHeight:checked.head.height,checkedBlock:checked.head.hash}};
    delete intent.id;intent.id=fingerprint(intent);return freeze(intent);
  }
  verifyIntent(n,intent){const {id,...content}=intent;need(fingerprint(content)===id&&intent.networkFingerprint===bitcoinNetworkFingerprint(n),'BITCOIN_INTENT_CHANGED');need(this.now()>=intent.createdAt&&this.now()<intent.expiresAt,'BITCOIN_INTENT_EXPIRED');}
  async sign(vault,network,intent,{authorize=()=>{}}={}){
    const n=validateBitcoinNetwork(network);this.verifyIntent(n,intent);vault.check();const epoch=vault.epoch;const a=vault.account(intent.accountId);
    need(a.address===intent.payment.from,'BITCOIN_SIGNER_MISMATCH');await this.inspect(n,intent.payment);
    vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');
    return vault.signNonEvmAndRecord(intent,secret=>{authorize();this.verifyIntent(n,intent);need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');return signBitcoinPayment(secret,intent.payment);});
  }
  async currentRecord(vault,n,candidate){const r=(await vault.nonEvmRecords()).find(r=>r.id===candidate.id);need(r&&r.family==='bitcoin'&&r.summary.operation==='bitcoin-p2wpkh-online','BITCOIN_ONLINE_RECORD_REQUIRED');need(r.summary.networkFingerprint===bitcoinNetworkFingerprint(n),'BITCOIN_RECORD_NETWORK_CHANGED');verifyBitcoinSigned(r.signed,r.summary);return r;}
  async broadcast(vault,network,candidate,{authorize=()=>{}}={}){
    const n=validateBitcoinNetwork(network);need(n.broadcastEnabled,'BROADCAST_DISABLED');vault.check();const epoch=vault.epoch,key=candidate.accountId;need(!this.active.has(key),'BITCOIN_OPERATION_BUSY');this.active.add(key);
    const guard=()=>{authorize();vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');};
    try{
      let r=await this.currentRecord(vault,n,candidate);guard();
      // Repeated submit is NOT a resend. Reconcile manually; ambiguity remains reserved.
      need(r.state==='signed','BITCOIN_REBROADCAST_NOT_IMPLEMENTED');
      const checked=await this.inspect(n,r.summary.transfer);guard();
      const maxRate=satoshisBtc(BigInt(r.summary.transfer.maxFeeRateSatVb)*1000n);
      const tests=await this.rpc.all(n,'testmempoolaccept',[[r.signed.rawTransactionHex],maxRate]);
      for(const rows of tests){need(Array.isArray(rows)&&rows.length===1,'BITCOIN_PREFLIGHT_INVALID');const v=rows[0];need(v.allowed===true,'BITCOIN_MEMPOOL_REJECTED');need(v.txid===r.signed.requestId&&v.wtxid===r.signed.wtxid&&rpcInteger(v.vsize)===r.signed.vsize&&btcSatoshis(v.fees?.base)===r.summary.feeAtomic,'BITCOIN_PREFLIGHT_CONTENT_MISMATCH');}
      await this.stable(n,checked.head);guard();
      r=await vault.observeNonEvm(r,'broadcast-unknown',{observedAt:this.now(),received:false,reason:'submission-starting',assurance});guard();
      let state='broadcast',report={observedAt:this.now(),received:false,reason:'RPC-accepted-not-confirmed',assurance};
      try{const txid=await this.rpc.call(n,0,'sendrawtransaction',[r.signed.rawTransactionHex,maxRate]);need(txid===r.signed.requestId,'BITCOIN_RPC_TXID_MISMATCH');}
      catch(e){state='broadcast-unknown';report={observedAt:this.now(),received:false,reason:safeError(e),assurance};}
      guard();return await vault.observeNonEvm(r,state,report);
    }finally{this.active.delete(key);}
  }
  async reconcile(vault,network,candidate){
    const n=validateBitcoinNetwork(network);vault.check();const epoch=vault.epoch,r=await this.currentRecord(vault,n,candidate);const fallback=r.state==='signed'?'signed':'broadcast-unknown';
    let state=fallback,report={observedAt:this.now(),received:false,reason:'unresolved',assurance};
    try{
      const head=await this.snapshot(n);
      const txs=await Promise.all(n.rpcUrls.map(async(_,i)=>{try{return await this.rpc.call(n,i,'getrawtransaction',[r.signed.requestId,true]);}catch(e){if(e.rpcCode==='-5')return null;throw e;}}));
      need(txs.every(x=>(x===null)===(txs[0]===null)),'BITCOIN_RPC_DISAGREEMENT');
      if(txs[0]===null){report.reason='transaction-not-observed-reservation-retained';}
      else {
        const views=[];
        for(let i=0;i<txs.length;i++){
          const t=txs[i];need(t.hex===r.signed.rawTransactionHex&&t.txid===r.signed.requestId&&t.hash===r.signed.wtxid,'BITCOIN_RECEIPT_BYTES_MISMATCH');
          const parsed=parseBitcoinTransaction(t.hex);need(parsed.txid===r.signed.requestId&&parsed.wtxid===r.signed.wtxid&&parsed.vsize===r.signed.vsize,'BITCOIN_RECEIPT_BYTES_MISMATCH');
          if(!t.blockhash){views.push({confirmations:0,blockHash:null,blockHeight:null,inclusion:false});continue;}
          bitcoinHash(t.blockhash);need(t.in_active_chain!==false,'BITCOIN_BLOCK_NOT_ACTIVE');
          const block=await this.rpc.call(n,i,'getblock',[t.blockhash,1]);need(block.hash===t.blockhash&&Array.isArray(block.tx),'BITCOIN_BLOCK_INVALID');const height=rpcInteger(block.height,head.height);
          const active=await this.rpc.call(n,i,'getblockhash',[height]);need(active===t.blockhash,'BITCOIN_BLOCK_NOT_ACTIVE');
          const proof=verifyBitcoinBlockMembership(await this.rpc.call(n,i,'getblockheader',[t.blockhash,false]),t.blockhash,block.tx,r.signed.requestId);
          const confirmations=head.height-height+1;need(rpcInteger(t.confirmations)===confirmations&&rpcInteger(block.confirmations)===confirmations,'BITCOIN_CONFIRMATIONS_MISMATCH');
          views.push({confirmations,blockHash:t.blockhash,blockHeight:height,inclusion:proof.transactionMerkleInclusionVerified});
        }
        need(views.every(x=>canonical(x)===canonical(views[0])),'BITCOIN_RPC_DISAGREEMENT');const v=views[0];
        const received=v.confirmations>=n.minConfirmations&&v.inclusion;state=received?'reported-confirmed':'broadcast';report={...report,...v,received,reason:received?'RPC-active-chain-observed':'awaiting-confirmations',requiredConfirmations:n.minConfirmations,feeAtomic:r.summary.feeAtomic,finalityProven:false};
      }
      await this.stable(n,head);
    }catch(e){state=fallback;report={observedAt:this.now(),received:false,reason:safeError(e),assurance};}
    vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');return vault.observeNonEvm(r,state,report);
  }
}
