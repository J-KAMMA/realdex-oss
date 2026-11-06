/** Owner-only classic SPL transfers between pre-existing, explicitly verified token accounts. */
import {randomUUID} from 'node:crypto';
import {need,shape,canonical,uint,freeze} from '../lib/guard.mjs';
import {base58Decode} from '../lib/keys.mjs';
import {fingerprint,SYSTEM_PROGRAM} from './solana-codec.mjs';
import {SolanaEngine} from './solana-engine.mjs';
import {validateSolanaNetwork,solanaNetworkFingerprint,safeRpcInteger} from './solana-network.mjs';
import {TOKEN_PROGRAM,decodeSplAccount,decodeSplMint,splTransferMessage,unsignedSplTransfer,signSplTransfer,parseSignedSplTransfer} from './spl-codec.mjs';
export function normalizeSplPayment(n,a,raw) {
  shape(raw,['requestKey','mint','source','destination','to','amountAtomic']);
  need(typeof raw.requestKey==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(raw.requestKey),'PAYMENT_KEY_INVALID');
  need(a.family==='solana'&&a.kind==='local','SOLANA_LOCAL_ACCOUNT_REQUIRED');
  for(const k of ['mint','source','destination','to'])base58Decode(raw[k],32);
  const token=(n.splTokens??[]).find(t=>t.mint===raw.mint);need(token,'SPL_MINT_NOT_REGISTERED');
  const amount=uint(raw.amountAtomic,BigInt(token.maxTransferAtomic));need(amount>0n,'SPL_AMOUNT_ZERO');
  need(new Set([a.address,raw.source,raw.destination,raw.mint,TOKEN_PROGRAM]).size===5&&raw.to!==a.address&&raw.to!==SYSTEM_PROGRAM,'SPL_ACCOUNT_ALIAS_OR_SELF_TRANSFER');
  const p={family:'solana',operation:'spl-transfer-checked',networkId:n.id,genesisHash:n.genesisHash,accountId:a.id,from:a.address,to:raw.to,source:raw.source,destination:raw.destination,mint:raw.mint,amountAtomic:String(amount),decimals:token.decimals,programId:TOKEN_PROGRAM};
  return {...p,requestKey:raw.requestKey,paymentHash:fingerprint(p)};
}
const context=(r,min)=>{need(r?.context&&safeRpcInteger(r.context.slot)>=min&&Object.hasOwn(r,'value'),'SOLANA_RPC_CONTEXT_STALE');return r.value;};
const project=a=>a===null?null:{owner:a.owner,executable:a.executable,lamports:safeRpcInteger(a.lamports),data:a.data};
const native=a=>{need(a&&a.owner===SYSTEM_PROGRAM&&a.executable===false&&canonical(a.data)===canonical(['','base64']),'SOLANA_SYSTEM_ACCOUNT_REQUIRED');return BigInt(safeRpcInteger(a.lamports));};
function checkTokenAccount(a,mint,owner) {const v=decodeSplAccount(a);need(v.mint===mint&&v.owner===owner,'SPL_MINT_OR_AUTHORITY_MISMATCH');return v;}
export class SplEngine extends SolanaEngine {
  parseSigned(encoded){return parseSignedSplTransfer(encoded);}
  async inspectSpl(n,t,life,to) {
    await this.identity(n);await this.validity(n,life);
    const opts={commitment:'confirmed',encoding:'base64',minContextSlot:life.minContextSlot};
    const keys=[t.from,t.source,t.destination,t.mint];
    const accounts=await this.contextAgree(n,'getMultipleAccounts',[keys,opts],life.minContextSlot,as=>{need(Array.isArray(as)&&as.length===4,'SPL_ACCOUNTS_REQUIRED');return as.map(project);});
    const payer=native(accounts[0]),source=checkTokenAccount(accounts[1],t.mint,t.from),destination=checkTokenAccount(accounts[2],t.mint,to),mint=decodeSplMint(accounts[3]);
    need(mint.decimals===t.decimals,'SPL_DECIMALS_CHANGED');
    need(BigInt(source.amountAtomic)>=BigInt(t.amountAtomic),'INSUFFICIENT_SPL_BALANCE');
    need(BigInt(destination.amountAtomic)+BigInt(t.amountAtomic)<(1n<<64n),'SPL_DESTINATION_OVERFLOW');
    const fee=BigInt(safeRpcInteger(await this.contextAgree(n,'getFeeForMessage',[splTransferMessage(t).toString('base64'),{commitment:'confirmed',minContextSlot:life.minContextSlot}],life.minContextSlot)));
    need(fee>0n&&fee<=BigInt(n.maxFeeLamports),'SOLANA_FEE_CAP_EXCEEDED');need(payer>=fee,'INSUFFICIENT_SOL_FOR_FEE');
    for(const r of await this.rpc.all(n,'simulateTransaction',[unsignedSplTransfer(t),{...opts,sigVerify:false,replaceRecentBlockhash:false,accounts:{encoding:'base64',addresses:keys}}])){
      const v=context(r,life.minContextSlot);need(v&&v.err===null&&Array.isArray(v.accounts)&&v.accounts.length===4,'SPL_SIMULATION_FAILED');
      const after=v.accounts.map(project),aSource=checkTokenAccount(after[1],t.mint,t.from),aDestination=checkTokenAccount(after[2],t.mint,to);
      need(native(after[0])===payer-fee&&BigInt(source.amountAtomic)-BigInt(aSource.amountAtomic)===BigInt(t.amountAtomic)&&BigInt(aDestination.amountAtomic)-BigInt(destination.amountAtomic)===BigInt(t.amountAtomic),'SPL_SIMULATION_DELTA_MISMATCH');
      // Token amount is the only allowed changed field; native balances and all authority data are fixed.
      for(const index of [1,2]){const expected=Buffer.from(accounts[index].data[0],'base64');expected.writeBigUInt64LE(BigInt(index===1?aSource.amountAtomic:aDestination.amountAtomic),64);need(canonical({...accounts[index],data:[expected.toString('base64'),'base64']})===canonical(after[index]),'SPL_SIMULATION_SIDE_EFFECT');}
      need(canonical(after[3])===canonical(accounts[3]),'SPL_MINT_CHANGED_BY_SIMULATION');
    }
    // Supply is allowed to change elsewhere. Authorities/decimals must stay pinned to owner review.
    return {feeLamports:String(fee),sourceAtomic:source.amountAtomic,destinationAtomic:destination.amountAtomic,payerLamports:String(payer),mintAuthority:mint.mintAuthority,freezeAuthority:mint.freezeAuthority};
  }
  async accounts(network,owner,mintId) {
    const n=validateSolanaNetwork(network);base58Decode(owner,32);need((n.splTokens??[]).some(t=>t.mint===mintId),'SPL_MINT_NOT_REGISTERED');await this.identity(n);
    const entries=await this.contextAgree(n,'getTokenAccountsByOwner',[owner,{mint:mintId},{commitment:'confirmed',encoding:'base64'}],0,rows=>{need(Array.isArray(rows)&&rows.length<=64,'SPL_ACCOUNT_LIST_LIMIT');const list=rows.map(r=>{base58Decode(r.pubkey,32);const d=checkTokenAccount(r.account,mintId,owner);return {address:r.pubkey,amountAtomic:d.amountAtomic};}).sort((a,b)=>a.address.localeCompare(b.address));need(new Set(list.map(r=>r.address)).size===list.length,'SPL_DUPLICATE_ACCOUNTS');return list;});
    return {owner,mint:mintId,accounts:entries,observedAt:this.now(),assurance:'RPC observation, not consensus proof'};
  }
  async prepare(network,account,raw) {
    const n=validateSolanaNetwork(network),payment=normalizeSplPayment(n,account,raw),life=await this.latest(n);
    const {from,source,destination,mint,amountAtomic,decimals}=payment;
    const transfer={from,source,destination,mint,amountAtomic,decimals,recentBlockhash:life.recentBlockhash},costs=await this.inspectSpl(n,transfer,life,payment.to),createdAt=this.now(),expiresAt=createdAt+60000;
    const intent={family:'solana',accountId:account.id,networkId:n.id,networkFingerprint:solanaNetworkFingerprint(n),genesisHash:n.genesisHash,payment,life,transfer,costs,createdAt,expiresAt,salt:randomUUID()};
    const token=n.splTokens.find(x=>x.mint===mint);
    intent.summary={family:'solana',operation:'spl-transfer-checked',networkId:n.id,network:n.name,genesisHash:n.genesisHash,networkFingerprint:intent.networkFingerprint,from,recipient:payment.to,source,destination,mint,programId:TOKEN_PROGRAM,asset:token.symbol,amountAtomic,decimals,feeAtomic:costs.feeLamports,feeAsset:'SOL',totalDebitAtomic:amountAtomic,totalNativeDebitAtomic:costs.feeLamports,mintAuthority:costs.mintAuthority,freezeAuthority:costs.freezeAuthority,recentBlockhash:life.recentBlockhash,lastValidBlockHeight:life.lastValidBlockHeight,minContextSlot:life.minContextSlot,expiresAt,requestKey:payment.requestKey,paymentHash:payment.paymentHash,assurance:'local-RPC-observation-not-consensus-proof'};
    intent.id=fingerprint(intent);return freeze(intent);
  }
  async sign(vault,network,intent,{authorize=()=>{}}={}) {
    const n=validateSolanaNetwork(network);this.verifyIntent(n,intent);vault.check();const epoch=vault.epoch;
    need(vault.account(intent.accountId).address===intent.transfer.from,'SIGNER_ADDRESS_MISMATCH');
    const costs=await this.inspectSpl(n,intent.transfer,intent.life,intent.payment.to);
    for(const k of ['feeLamports','mintAuthority','freezeAuthority'])need(costs[k]===intent.costs[k],'SPL_REVIEW_STATE_CHANGED');
    need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');
    return vault.signNonEvmAndRecord(intent,secret=>{authorize();this.verifyIntent(n,intent);need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');return signSplTransfer(secret,intent.transfer);});
  }
  async beforeBroadcast(n,record) {
    const t=this.parseSigned(record.signed.transactionBase64).transfer,s=record.summary;
    const c=await this.inspectSpl(n,t,{recentBlockhash:s.recentBlockhash,lastValidBlockHeight:s.lastValidBlockHeight,minContextSlot:s.minContextSlot},s.recipient);
    need(c.feeLamports===s.feeAtomic&&c.mintAuthority===s.mintAuthority&&c.freezeAuthority===s.freezeAuthority,'SPL_REVIEW_STATE_CHANGED');
  }
  receipt(record,status,tx) {
    const s=record.summary,fee=BigInt(safeRpcInteger(tx.meta.fee));need(fee<=BigInt(s.feeAtomic),'SOLANA_ACTUAL_FEE_EXCEEDED');
    need(tx.meta.preBalances?.length===5&&tx.meta.postBalances?.length===5,'SPL_NATIVE_BALANCE_SHAPE');
    const pre=tx.meta.preBalances.map(v=>BigInt(safeRpcInteger(v))),post=tx.meta.postBalances.map(v=>BigInt(safeRpcInteger(v)));
    need(pre[0]-post[0]===fee&&post.slice(1).every((v,i)=>v===pre[i+1]),'SPL_NATIVE_DELTA_MISMATCH');
    const balances=rows=>{need(Array.isArray(rows)&&rows.length===2,'SPL_TOKEN_RECEIPT_REQUIRED');return [1,2].map(index=>{const r=rows.find(x=>x.accountIndex===index);need(r&&r.mint===s.mint&&r.programId===TOKEN_PROGRAM&&r.owner===(index===1?s.from:s.recipient)&&r.uiTokenAmount?.decimals===s.decimals,'SPL_TOKEN_RECEIPT_BINDING');return uint(r.uiTokenAmount.amount,(1n<<64n)-1n);});};
    const before=balances(tx.meta.preTokenBalances),after=balances(tx.meta.postTokenBalances),amount=status.err===null?BigInt(s.amountAtomic):0n;
    need(before[0]-after[0]===amount&&after[1]-before[1]===amount,'SPL_TOKEN_RECEIPT_DELTA_MISMATCH');
    return {slot:tx.slot,feeAtomic:String(fee),pre:pre.map(String),post:post.map(String),preTokenAtomic:before.map(String),postTokenAtomic:after.map(String)};
  }
}
