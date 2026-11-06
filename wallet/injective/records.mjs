import {RETIRED,SUBMISSION_EXPIRED,isInjectiveRetired,validateRetirement,assertInjectiveSequenceAvailable} from './retirement.mjs';
import {need,shape,canonical} from '../lib/guard.mjs';
import {validateInjectiveReview,verifyInjectiveSigned,injectiveReviewFromSummary,injectiveOperation,injectiveReviewPlan,checkInjectiveSummary,INJECTIVE_NETWORK} from './codec.mjs';
export const INJECTIVE_STATES=Object.freeze(['signed','broadcast-unknown','broadcast','reported-confirmed','reported-reverted',RETIRED,SUBMISSION_EXPIRED]);
function report(r,state){
 if(r===undefined){need(state==='signed','INJECTIVE_REPORT_REQUIRED');return;}
 shape(r,['observedAt','received','reason','transactionHash','automaticRetry','finalityProven'],['height','code','actionEffect']);need(Number.isSafeInteger(r.observedAt)&&r.observedAt>=0&&typeof r.received==='boolean'&&typeof r.reason==='string'&&r.reason.length>0&&r.reason.length<=90&&/^[A-F0-9]{64}$/.test(r.transactionHash)&&r.automaticRetry===false&&r.finalityProven===false,'INJECTIVE_REPORT_INVALID');
 if(r.height!==undefined)need(typeof r.height==='string'&&/^[1-9][0-9]{0,19}$/.test(r.height),'INJECTIVE_REPORT_INVALID');if(r.code!==undefined)need(Number.isSafeInteger(r.code)&&r.code>=0,'INJECTIVE_REPORT_INVALID');
 if(r.actionEffect!==undefined){
  const e=r.actionEffect;need(state==='reported-confirmed'&&['cancel','withdraw','deposit'].includes(e?.kind)&&e.independentProof===false,'INJECTIVE_ACTION_EFFECT');
  if(e.status==='unavailable')shape(e,['kind','status','independentProof']);
  else{need(e.status==='observed'&&e.height===r.height,'INJECTIVE_ACTION_EFFECT');shape(e,e.kind==='cancel'?['kind','status','height','orderPresent','independentProof']:['kind','status','height','availableAtomic','totalAtomic','bankBalanceAtomic','independentProof']);
   if(e.kind==='cancel')need(typeof e.orderPresent==='boolean','INJECTIVE_ACTION_EFFECT');else for(const k of ['availableAtomic','totalAtomic','bankBalanceAtomic'])need(typeof e[k]==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(e[k]),'INJECTIVE_ACTION_EFFECT');}
 }
 if(state==='reported-confirmed')need(r.received===true&&r.code===0&&r.height!==undefined,'INJECTIVE_CONFIRMED_REPORT_INVALID');if(state==='reported-reverted')need(r.code===undefined||r.code!==0,'INJECTIVE_REVERTED_REPORT_INVALID');
}
export function validateInjectiveRecord(r,accounts){
 shape(r,['id','intentId','requestKey','paymentHash','accountId','family','state','createdAt','summary','signed'],['report','retirement']);need(typeof r.id==='string'&&typeof r.intentId==='string'&&r.family==='injective'&&INJECTIVE_STATES.includes(r.state)&&Number.isSafeInteger(r.createdAt)&&r.createdAt>=0,'INJECTIVE_RECORD_INVALID');
 const a=accounts.find(a=>a.id===r.accountId);need(a?.kind==='local'&&a.family==='evm','INJECTIVE_RECORD_ACCOUNT');const s=r.summary;
 need(s.family==='injective'&&s.networkId===INJECTIVE_NETWORK&&s.from===a.address&&s.requestKey===r.requestKey&&s.paymentHash===r.paymentHash,'INJECTIVE_RECORD_BINDING');
 const review=injectiveReviewFromSummary(s);validateInjectiveReview(review,a,{fresh:false});need(review.reviewSha256===s.reviewSha256&&injectiveReviewPlan(review).requestKey===r.requestKey&&s.operation===injectiveOperation(review)&&s.confirmationText===s.reviewSha256,'INJECTIVE_RECORD_REVIEW');checkInjectiveSummary(s,review);verifyInjectiveSigned(r.signed,s,a);if(isInjectiveRetired(r.state))validateRetirement(r);else need(r.retirement===undefined,'INJECTIVE_RETIREMENT_INVALID');report(r.report,isInjectiveRetired(r.state)?(r.state===RETIRED?'signed':r.retirement.review.originalState):r.state);if(r.report)need(r.report.transactionHash===r.signed.requestId,'INJECTIVE_REPORT_HASH_MISMATCH');if(r.report?.actionEffect)need(r.report.actionEffect.kind===review.action?.kind,'INJECTIVE_ACTION_EFFECT');return r;
}
export function validateInjectiveJournal(data){if(data.injectiveJournal===undefined)return;need(Array.isArray(data.injectiveJournal)&&data.injectiveJournal.length<=64,'INJECTIVE_JOURNAL_LIMIT');const ids=new Set(),keys=new Set(),seen=[],hashes=new Set();
 for(const r of data.injectiveJournal){validateInjectiveRecord(r,data.accounts);const k=canonical([r.accountId,r.summary.networkId,r.requestKey]);need(!ids.has(r.id)&&!keys.has(k)&&!hashes.has(r.signed.requestId),'INJECTIVE_JOURNAL_DUPLICATE');assertInjectiveSequenceAvailable(seen,r.summary);seen.push(r);ids.add(r.id);keys.add(k);hashes.add(r.signed.requestId);}}
