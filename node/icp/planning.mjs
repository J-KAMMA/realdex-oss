/** Offline ICP settlement models. Not canister code; nothing in this module
 * signs, sends, approves or declares a ledger result cryptographically verified. */
import {check,keys,uint,freeze} from '../extended/guard.mjs';
import {canonical} from '../chains/core.mjs';
import {icrcAsset,icrcAccount} from './principal.mjs';
function value(s){check(typeof s==='string','ATOMIC_AMOUNT_STRING_REQUIRED');return uint(s);}
export function quoteIcrcPool(input){
 keys(input,['network','ledgerIn','ledgerOut','reserveInAtomic','reserveOutAtomic','inputBudgetAtomic','inputTransferFeeAtomic','outputTransferFeeAtomic','poolFeeBps','slippageBps']);
 const assetIn=icrcAsset(input.network,input.ledgerIn),assetOut=icrcAsset(input.network,input.ledgerOut);check(assetIn.key!==assetOut.key,'IDENTICAL_ASSETS');
 for(const k of ['poolFeeBps','slippageBps'])check(Number.isInteger(input[k])&&input[k]>=0&&input[k]<10000,'BPS_INVALID');
 const ri=value(input.reserveInAtomic),ro=value(input.reserveOutAtomic),budget=value(input.inputBudgetAtomic),feeIn=value(input.inputTransferFeeAtomic),feeOut=value(input.outputTransferFeeAtomic);
 check(ri>0n&&ro>0n,'EMPTY_POOL');check(budget>feeIn,'INPUT_BUDGET_TOO_SMALL');const amount=budget-feeIn;
 const weighted=amount*BigInt(10000-input.poolFeeBps),gross=weighted*ro/(ri*10000n+weighted);check(gross>feeOut,'OUTPUT_BELOW_TRANSFER_FEE');
 const net=gross-feeOut,min=net*BigInt(10000-input.slippageBps)/10000n;check(min>0n,'MINIMUM_OUTPUT_ZERO');
 check((ri+amount)*(ro-gross)>=ri*ro,'CPMM_INVARIANT_FAILED');
 return freeze({schema:'realdex.icrc-cpmm-model-quote.v1',assetIn,assetOut,inputBudgetAtomic:String(budget),poolInputAtomic:String(amount),
  inputTransferFeeAtomic:String(feeIn),grossPoolDebitOutAtomic:String(gross),outputTransferFeeAtomic:String(feeOut),netOutAtomic:String(net),minimumNetOutAtomic:String(min),
  reserveAfterInAtomic:String(ri+amount),reserveAfterOutAtomic:String(ro-gross),
  assumptions:['Exact-transfer ordinary ICRC transfers; mint/burn accounts excluded.',
   'The pool pays the output ledger fee from the gross output debit.',
   'Approval fees, cycles, bridge costs and verified live reserves are not included.',
   'Distinct ledger calls are asynchronous; no all-or-nothing cross-ledger execution is claimed.'],
  modelOnly:true,requiresNonAtomicRecovery:true,executable:false});
}
export async function transferIntent(raw){
 keys(raw,['network','ledger','from','to','amountAtomic','feeAtomic','memoHex','createdAtTimeNs']);const asset=icrcAsset(raw.network,raw.ledger),from=icrcAccount(raw.from),to=icrcAccount(raw.to);
 check(from.key!==to.key,'SELF_TRANSFER_MODEL_REJECTED');const amount=value(raw.amountAtomic),fee=value(raw.feeAtomic);check(amount>0n,'AMOUNT_ZERO');
 check(typeof raw.memoHex==='string'&&/^[0-9a-fA-F]{64}$/.test(raw.memoHex),'MEMO_32_BYTES_REQUIRED');const created=uint(raw.createdAtTimeNs,(1n<<64n)-1n);check(created>0n,'CREATED_TIME_REQUIRED');
 const terms={asset,from,to,amountAtomic:String(amount),feeAtomic:String(fee),memoHex:raw.memoHex.toLowerCase(),createdAtTimeNs:String(created)};
 const hash=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(terms))),id=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
 return freeze({schema:'realdex.icrc-transfer-intent.v1',id,terms,totalDebitAtomic:String(amount+fee),serializedTransaction:false,executable:false});
}
export function newSettlementRecord(intent){
 check(intent?.schema==='realdex.icrc-transfer-intent.v1'&&/^[0-9a-f]{64}$/.test(intent.id)&&intent.executable===false,'INTENT_INVALID');
 return freeze({schema:'realdex.icrc-settlement-model.v1',intentId:intent.id,state:'prepared',submissionCount:0,reportedBlock:null,manualReconciliationRequired:false,settlementVerified:false,executable:false});
}
export function advanceSettlement(raw,event){
 keys(raw,['schema','intentId','state','submissionCount','reportedBlock','manualReconciliationRequired','settlementVerified','executable']);
 check(raw.schema==='realdex.icrc-settlement-model.v1'&&/^[0-9a-f]{64}$/.test(raw.intentId)&&raw.settlementVerified===false&&raw.executable===false,'STATE_INVALID');
 check(['prepared','in-flight','uncertain','reported-success','reported-rejection'].includes(raw.state),'STATE_INVALID');
 check(raw.submissionCount===(raw.state==='prepared'?0:1),'STATE_INVALID');
 check(raw.reportedBlock===null||typeof raw.reportedBlock==='string'&&/^(0|[1-9][0-9]*)$/.test(raw.reportedBlock),'STATE_INVALID');
 check(typeof raw.manualReconciliationRequired==='boolean','STATE_INVALID');
 check((raw.state==='reported-success')===(raw.reportedBlock!==null),'STATE_INVALID');
 check(raw.manualReconciliationRequired===!['prepared','in-flight'].includes(raw.state),'STATE_INVALID');
 keys(event,['intentId','kind'],['blockIndex']);check(event.intentId===raw.intentId,'INTENT_BINDING_MISMATCH');const s={...raw};
 if(event.kind==='begin'){
  check(raw.state==='prepared'&&!Object.hasOwn(event,'blockIndex'),'RESUBMISSION_FORBIDDEN');s.state='in-flight';s.submissionCount=1;
 }else{
  check(['in-flight','uncertain'].includes(raw.state),'STATE_TRANSITION_FORBIDDEN');
  if(['ok','duplicate'].includes(event.kind)){
   s.reportedBlock=String(uint(event.blockIndex));s.state='reported-success';s.manualReconciliationRequired=true;
  }else {check(!Object.hasOwn(event,'blockIndex'),'EVENT_INVALID');check(['transport-unknown','too-old','created-in-future','bad-fee','insufficient-funds','temporary-unavailable','generic-error'].includes(event.kind),'EVENT_INVALID');
   // TooOld/BadFee after uncertain delivery does not prove an earlier transfer
   // failed. Never refresh the memo/time/fee and resend an ambiguous intent.
   s.state=event.kind==='transport-unknown'||raw.state==='uncertain'?'uncertain':'reported-rejection';s.manualReconciliationRequired=true;
  }
 }
 return freeze(s);
}
