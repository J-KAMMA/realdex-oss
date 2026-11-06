/** Native XLM only. Horizon observations never constitute SCP/finality proofs. */
import {need,uint,canonical} from '../lib/guard.mjs';
import {ACCOUNT_ASSURANCE,int,hash,decimalAtomic} from './account-network.mjs';
import {decodeStellarPaymentResult} from './stellar-result.mjs';
import {decodeStellarAddress} from '../codec/strkey.mjs';

/**
 * A ledger closing in the middle of a read is not something the owner can act on. The
 * view was refused for being momentarily inconsistent, not for being wrong, and the
 * answer to it is to read again. Nothing did: the refusal reached the caller and the
 * operation simply failed. Public Stellar closes about every five seconds, which a slow
 * pair of readers straddles often enough to matter; the local Core the acceptance gate
 * runs closes in well under a second, which turned "often enough" into about half of
 * all runs.
 *
 * So the read-only cycles read again, a bounded number of times, each attempt starting
 * from a fresh snapshot. Nothing is relaxed. An accepted view still has to satisfy
 * every check, including that every reader returned the identical value, so a reader
 * that lies can only exhaust the bound — it can never be believed. An adversary holding
 * one endpoint gains nothing either: it could already stall the owner by answering
 * slowly or not at all. "Refuse immediately" becomes "refuse after four attempts".
 *
 * Submission is deliberately not in this set and is never retried.
 */
const CONSISTENCY_ATTEMPTS=4;
const READ_AGAIN=new Set(['STELLAR_LEDGER_CHANGED','STELLAR_ACCOUNT_CHANGED','ACCOUNT_RPC_TIME_SKEW']);
async function readAgain(attempt){
  for(let n=1;;n++){
    try{return await attempt();}
    catch(error){if(n>=CONSISTENCY_ATTEMPTS||!READ_AGAIN.has(error?.message))throw error;}
  }
}

export class StellarAdapter {
  constructor(rest,now){this.rest=rest;this.now=now;}
  projectLedger(v){
    need(v&&typeof v.closed_at==='string','STELLAR_LEDGER_INVALID');
    const timestamp=Date.parse(v.closed_at);need(Number.isSafeInteger(timestamp),'STELLAR_LEDGER_TIME');
    const height=int(v.sequence,2147483647);need(height>=1,'STELLAR_LEDGER_INVALID');
    return {height,hash:hash(v.hash),timestamp,baseFeeAtomic:String(int(v.base_fee_in_stroops,10000000)),baseReserveAtomic:String(int(v.base_reserve_in_stroops,10000000000))};
  }
  async snapshot(n){
    const root=await this.rest.agree(n,'',undefined,r=>{
      need(r?.network_passphrase===n.networkPassphrase,'STELLAR_NETWORK_MISMATCH');
      const height=int(r.history_latest_ledger,2147483647),core=int(r.core_latest_ledger,2147483647);
      need(height>=n.checkpoint.height&&core>=height&&core-height<=4,'STELLAR_HORIZON_LAG');return {height};
    },{moving:true});
    const pin=await this.rest.agree(n,`ledgers/${n.checkpoint.height}`,undefined,v=>this.projectLedger(v));
    need(pin.height===n.checkpoint.height&&pin.hash===n.checkpoint.hash,'ACCOUNT_CHECKPOINT_MISMATCH');
    const head=await this.rest.agree(n,`ledgers/${root.height}`,undefined,v=>this.projectLedger(v));
    need(head.height===root.height&&head.baseFeeAtomic!=='0'&&head.baseReserveAtomic!=='0','STELLAR_LEDGER_INVALID');
    need(head.timestamp<=this.now()+30000&&this.now()-head.timestamp<=60000,'ACCOUNT_LEDGER_STALE_OR_FUTURE');
    return head;
  }
  /**
   * The figures were read against `head`. This decides whether they may still be shown
   * together.
   *
   * It used to require that the head had not moved at all, which is stricter than the
   * property it protects. What makes a view wrong is figures spanning two states, and
   * that is caught elsewhere and precisely: both accounts are read twice and must be
   * identical, and neither may have been modified after `head`. A ledger that closed
   * without touching either account changes nothing that is on the screen.
   *
   * What is actually required, and is what is required here:
   *
   *   - no rewind. Stellar does not reorganise, so a lower height is an endpoint lying
   *     or a different network. Fatal, and not something to read again.
   *   - the fee and reserve priced against are still current. They come from `head` and
   *     decide STELLAR_FEE_TOO_LOW and the reserve, so a protocol change to either during
   *     the read has to surface rather than be re-priced underneath the owner.
   *   - the same height still means the same ledger. A ledger at a given height does not
   *     change, so reading it differently at the height it was just read at is an
   *     integrity failure and not the clock. It gets its own name and is fatal: calling
   *     it STELLAR_LEDGER_CHANGED put it in the read-again set, where a second attempt
   *     found the endpoints agreeing on their new answer and accepted it. That is the
   *     alarm-softening this whole change was written to stop, and the negative control
   *     for these tests is what caught it.
   *
   * The head the figures belong to is reported as `checkedHead`, so what the owner sees
   * still names the ledger it was true at.
   *
   * Stellar only. The bitcoin and aptos engines keep the strict rule until someone
   * measures them the way this was measured. See the internal design notes (not published), which
   * also records that the failure this was first proposed to fix turned out to be a
   * different defect entirely.
   */
  async stable(n,head){
    const latest=await this.snapshot(n);
    need(latest.height>=head.height,'STELLAR_LEDGER_REWOUND');
    need(latest.baseFeeAtomic===head.baseFeeAtomic&&latest.baseReserveAtomic===head.baseReserveAtomic,'STELLAR_LEDGER_PARAMETERS_CHANGED');
    if(latest.height===head.height)need(canonical(latest)===canonical(head),'STELLAR_LEDGER_CONTENT_CHANGED');
  }
  async account(n,address,head,{signer=false}={}){
    decodeStellarAddress(address);
    return this.rest.agree(n,`accounts/${address}`,undefined,v=>{
      need(v?.account_id===address&&Array.isArray(v.balances)&&Array.isArray(v.signers),'STELLAR_ACCOUNT_INVALID');
      const balances=v.balances.filter(b=>b.asset_type==='native');need(balances.length===1,'STELLAR_NATIVE_BALANCE_INVALID');
      const b=balances[0],balanceAtomic=decimalAtomic(b.balance,7),sellingAtomic=decimalAtomic(b.selling_liabilities??'0',7),buyingAtomic=decimalAtomic(b.buying_liabilities??'0',7);
      const sub=int(v.subentry_count,1000000),sponsoring=int(v.num_sponsoring,1000000),sponsored=int(v.num_sponsored,1000000);
      const reserveEntries=2+sub+sponsoring-sponsored;need(reserveEntries>=0,'STELLAR_RESERVE_INVALID');
      const reserveAtomic=String(BigInt(reserveEntries)*BigInt(head.baseReserveAtomic));
      for(const amount of [balanceAtomic,sellingAtomic,buyingAtomic,reserveAtomic])uint(amount,(1n<<63n)-1n);
      // The account is read pinned to `head`, so being last modified in a later ledger
      // means one closed between the two reads and this view spans two states. That is
      // the same "read it again" condition as anywhere else. It used to be written as
      // int(..., head.height) — the head as an integer bound standing in for a domain
      // rule — so it surfaced as ACCOUNT_RPC_INTEGER_RANGE, a message naming neither
      // the field nor the cause, and no retry recognised it.
      const sequence=String(uint(v.sequence,(1n<<63n)-1n)),modified=int(v.last_modified_ledger,2147483647);
      need(modified<=head.height,'STELLAR_LEDGER_CHANGED');
      const threshold=int(v.thresholds?.med_threshold,255);
      const signers=v.signers.map(s=>{decodeStellarAddress(s.key);need(s.type==='ed25519_public_key','STELLAR_SIGNER_TYPE_UNSUPPORTED');return {key:s.key,type:s.type,weight:int(s.weight,255)};}).sort((a,b)=>a.key.localeCompare(b.key));
      if(signer)need(signers.length===1&&signers[0].key===address&&signers[0].weight>0&&signers[0].weight>=threshold,'STELLAR_MASTER_SIGNATURE_INSUFFICIENT');
      const memoRequired=v.data?.['config.memo_required']==='MQ==';
      return {address,sequence,balanceAtomic,sellingAtomic,buyingAtomic,reserveAtomic,modified,threshold,signers,memoRequired};
    },{moving:true});
  }
  async inspect(n,a,user,expected){return readAgain(()=>this.inspectOnce(n,a,user,expected));}
  async inspectOnce(n,a,user,expected){
    const head=await this.snapshot(n);
    const source=await this.account(n,a.address,head,{signer:true});
    const destination=await this.account(n,user.to,head);
    need(BigInt(source.balanceAtomic)-BigInt(source.sellingAtomic)-BigInt(source.reserveAtomic)>=BigInt(user.amountAtomic)+BigInt(user.feeAtomic),'STELLAR_BALANCE_OR_RESERVE');
    need(BigInt(user.feeAtomic)>=BigInt(head.baseFeeAtomic),'STELLAR_FEE_TOO_LOW');
    need(BigInt(destination.balanceAtomic)+BigInt(destination.buyingAtomic)+BigInt(user.amountAtomic)<=(1n<<63n)-1n,'STELLAR_DESTINATION_CAPACITY');
    need(!destination.memoRequired||user.memo.length>0,'STELLAR_DESTINATION_MEMO_REQUIRED');
    if(expected){
      need(BigInt(expected.sequence)===BigInt(source.sequence)+1n,'ACCOUNT_SEQUENCE_CHANGED');
      need(BigInt(expected.maxTime)>BigInt(Math.floor(this.now()/1000)),'ACCOUNT_TRANSACTION_EXPIRED');
    }
    // Accounts are not historical Horizon reads: reread and refuse any changing view.
    need(canonical(await this.account(n,a.address,head,{signer:true}))===canonical(source)&&canonical(await this.account(n,user.to,head))===canonical(destination),'STELLAR_ACCOUNT_CHANGED');
    await this.stable(n,head);
    return {head,source,destination};
  }
  payment(n,a,u,checked){return {...u,networkPassphrase:n.networkPassphrase,sequence:String(BigInt(checked.source.sequence)+1n),maxTime:String(Math.floor(this.now()/1000)+180),acknowledgeUnverifiedState:true};}
  async balance(n,a){return readAgain(()=>this.balanceOnce(n,a));}
  async balanceOnce(n,a){
    const head=await this.snapshot(n),account=await this.account(n,a.address,head,{signer:true});await this.stable(n,head);
    return {networkId:n.id,address:a.address,asset:'XLM-standalone',decimals:7,account,head,observedAt:this.now(),assurance:ACCOUNT_ASSURANCE,finalityProven:false};
  }
  async submit(n,r){
    const v=await this.rest.call(n,0,'transactions',{method:'POST',contentType:'application/x-www-form-urlencoded',body:new URLSearchParams({tx:r.signed.envelopeXdrBase64}).toString()});
    need(v?.hash===r.signed.requestId,'ACCOUNT_SUBMISSION_HASH_MISMATCH');
  }
  async receipt(n,r){return readAgain(()=>this.receiptOnce(n,r));}
  async receiptOnce(n,r){
    const head=await this.snapshot(n);
    const transaction=await this.rest.agree(n,`transactions/${r.signed.requestId}`,{notFound:true},v=>{
      if(v===null)return null;
      const s=r.summary,t=s.transfer;
      need(v.hash===r.signed.requestId&&v.envelope_xdr===r.signed.envelopeXdrBase64&&v.source_account===s.from&&v.source_account_sequence===t.sequence&&v.fee_account===s.from&&int(v.operation_count)===1&&String(v.max_fee)===s.feeAtomic&&typeof v.successful==='boolean','STELLAR_RECEIPT_MISMATCH');
      const fee=String(uint(String(v.fee_charged),BigInt(s.feeAtomic)));need(BigInt(fee)>0n,'STELLAR_RECEIPT_FEE_INVALID');
      decodeStellarPaymentResult(v.result_xdr,fee,v.successful);
      // The same shape as the account read below: the head was an integer bound standing
      // in for a domain rule. A transaction that landed after the head this receipt is
      // being measured against is not an out-of-range integer — it is a head read a
      // moment too early, and confirmations computed from it would come out at zero or
      // less. Saying so puts it in the read-again set instead of reporting
      // ACCOUNT_RPC_INTEGER_RANGE, which names neither the field nor the cause. This
      // fires routinely: reconciling straight after a submit asks about a transaction
      // that is landing right now.
      const ledger=int(v.ledger,2147483647);
      need(ledger<=head.height,'STELLAR_LEDGER_CHANGED');
      return {success:v.successful,ledger,feeAtomic:fee};
    },{moving:true});
    if(transaction===null)return {received:false,reason:'transaction-not-observed-reservation-retained'};
    const ledger=await this.rest.agree(n,`ledgers/${transaction.ledger}`,undefined,v=>this.projectLedger(v));
    need(ledger.height===transaction.ledger&&ledger.height>=n.checkpoint.height&&BigInt(Math.floor(ledger.timestamp/1000))<=BigInt(r.summary.transfer.maxTime),'STELLAR_RECEIPT_LEDGER_INVALID');
    const confirmations=head.height-ledger.height+1;
    if(transaction.success){
      const op=await this.rest.agree(n,`transactions/${r.signed.requestId}/operations?limit=2&include_failed=true`,undefined,v=>{
        const rows=v?._embedded?.records;need(Array.isArray(rows)&&rows.length===1,'STELLAR_OPERATION_COUNT');
        const x=rows[0];need(x.type==='payment'&&x.type_i===1&&x.asset_type==='native'&&x.from===r.summary.from&&x.to===r.summary.recipient&&decimalAtomic(x.amount,7)===r.summary.amountAtomic&&x.transaction_hash===r.signed.requestId&&x.transaction_successful===true,'STELLAR_PAYMENT_EFFECT_MISMATCH');return true;
      });
      need(op,'STELLAR_PAYMENT_EFFECT_MISMATCH');
    }
    const source=await this.account(n,r.summary.from,head,{signer:true});
    need(BigInt(source.sequence)>=BigInt(r.summary.transfer.sequence),'STELLAR_RECEIPT_SEQUENCE_MISMATCH');
    await this.stable(n,head);
    const enough=confirmations>=n.minConfirmations;
    return {received:enough&&transaction.success,reason:enough?(transaction.success?'RPC-payment-observed':'RPC-execution-failed'):'awaiting-confirmations',failed:enough&&!transaction.success,ledger:ledger.height,ledgerHash:ledger.hash,feeAtomic:transaction.feeAtomic,transferObserved:transaction.success,balanceDeltaVerified:false,confirmations,requiredConfirmations:n.minConfirmations};
  }
}
