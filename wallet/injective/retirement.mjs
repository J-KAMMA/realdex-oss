import {checkInjectiveContinuity} from './continuity.mjs';
/** Owner-reviewed expiry barriers for local, ordered, signed transactions.
 * Unsent and possibly-submitted histories have DIFFERENT receipt types. No resend.
 * Submitted history is never relabeled unsent; expiry/unused sequence observations
 * permit a separate owner-approved successor, not a claim that funds never moved.
 * Hash/height/account readings are selected-node observations, NOT independent proofs.
 */
import {createHash} from 'node:crypto';
import {fields,one,text as protoText} from '../../node/external/protobuf.mjs';
import {need,shape,canonical,clone,uint,freeze} from '../lib/guard.mjs';
import {injectiveReviewFromSummary} from './codec.mjs';
export const RETIRED='retired-unsent-expired';
export const RECOVERY_SCHEMA='realdex.injective-unsent-retirement-review.v1';
export const RETIREMENT_SCHEMA='realdex.injective-unsent-retirement.v1';
export const SUBMISSION_EXPIRED='retired-submission-expired';
export const SUBMISSION_REVIEW_SCHEMA='realdex.injective-submission-expiry-review.v1';
export const SUBMISSION_RETIREMENT_SCHEMA='realdex.injective-submission-expiry.v1';
export const isInjectiveRetired=state=>state===RETIRED||state===SUBMISSION_EXPIRED;
const attemptedStates=['broadcast-unknown','broadcast','reported-reverted'];
/** No free-form RPC failure can become evidence of confirmed rejection. */
export function submissionRetirementEligible(record){
 const p=record.report;
 return !record.retirement&&attemptedStates.includes(record.state)&&p?.received===false&&p.height===undefined&&p.actionEffect===undefined&&
  (record.state==='reported-reverted'?p.reason==='CHECKTX_REJECTED'&&Number.isSafeInteger(p.code)&&p.code>0:p.code===undefined||p.code===0);
}
export function retirementTarget(record){
 if(submissionRetirementEligible(record))return SUBMISSION_EXPIRED;
 eligibleUnsent(record);return RETIRED;
}
const U64=(1n<<64n)-1n,MAX_AGE=30000;
const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
const eq=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
const unsigned=n=>uint(n,U64);
export const injectiveResolved=r=>['reported-confirmed','reported-reverted'].includes(r.state)||isInjectiveRetired(r.state);

/** Read the timeout and sequence from the SIGNED bytes, not just display fields. */
export function signedRecoveryBoundary(record){
 const review=injectiveReviewFromSummary(record.summary),tx=review.transaction;
 const raw=fields(Buffer.from(record.signed.txRawBase64,'base64'));
 need([...raw.keys()].every(k=>[1,2,3].includes(k)),'INJECTIVE_RECOVERY_TX_FIELDS');
 const body=one(raw,1,2),auth=one(raw,2,2),doc=fields(Buffer.from(tx.signDocBase64,'base64'));
 need([...doc.keys()].every(k=>[1,2,3,4].includes(k))&&eq(one(doc,1,2),body)&&eq(one(doc,2,2),auth),'INJECTIVE_RECOVERY_SIGNDOC_BINDING');
 need(protoText(doc,3)===review.chainId&&review.chainId==='injective-888'&&one(doc,4,0,0n)===unsigned(review.account.accountNumber),'INJECTIVE_RECOVERY_ACCOUNT_BINDING');
 const b=fields(body),a=fields(auth);need([...b.keys()].every(k=>[1,3].includes(k))&&b.get(1)?.length===1&&[...a.keys()].every(k=>[1,2].includes(k)),'INJECTIVE_RECOVERY_TX_FIELDS');
 const timeout=one(b,3,0,0n),signer=fields(one(a,1,2)),sequence=one(signer,3,0,0n);
 need(timeout>0n&&timeout===unsigned(tx.timeoutHeight)&&String(timeout)===record.summary.timeoutHeight&&sequence===unsigned(review.account.sequence),'INJECTIVE_RECOVERY_SIGNED_BOUNDARY');
 return {chainId:review.chainId,endpoint:review.endpoint,address:review.account.address,accountNumber:review.account.accountNumber,sequence:String(sequence),timeoutHeight:String(timeout),publicKeyHex:review.account.publicKeyHex};
}
function recordDigest(record,originalState='signed'){const {retirement,...r}=record;return hash({...r,state:originalState});}
function reviewKind(p){return p.schema===SUBMISSION_REVIEW_SCHEMA;}
function originalFor(p,record){
 const attempted=reviewKind(p),originalState=attempted?p.originalState:'signed';
 need(!attempted||attemptedStates.includes(originalState),'INJECTIVE_RECOVERY_ORIGINAL_STATE');
 const expected=attempted?SUBMISSION_EXPIRED:RETIRED;
 need(record.state===originalState||record.state===expected,'INJECTIVE_RECOVERY_ORIGINAL_STATE');
 return {...record,state:originalState,retirement:undefined};
}
function facts(e,b,at){
 shape(e,['height','blockHash','blockTimeMs','accountNumber','sequence','transactionNotFound']);
 need(unsigned(e.height)>unsigned(b.timeoutHeight)&&/^[a-f0-9]{64}$/.test(e.blockHash)&&e.blockHash!=='0'.repeat(64),'INJECTIVE_RECOVERY_NOT_EXPIRED');
 need(Number.isSafeInteger(at)&&at>=0&&Number.isSafeInteger(e.blockTimeMs)&&e.blockTimeMs>0&&e.blockTimeMs<=at+2000&&at-e.blockTimeMs<=MAX_AGE,'INJECTIVE_RECOVERY_BLOCK_STALE');
 need(e.accountNumber===b.accountNumber&&e.sequence===b.sequence&&e.transactionNotFound===true,'INJECTIVE_RECOVERY_ACCOUNT_CHANGED');
}
export function validateRetirementReview(p,record,{now=Date.now(),fresh=true}={}){
 const attempted=reviewKind(p);
 shape(p,['schema','recordId','accountId','transactionHash','recordSha256','boundary','evidence','observedAt','expiresAt','neverSubmittedByWallet','chainStateAuthenticated','settlementVerified','automaticRetryAllowed','reviewSha256',...(attempted?['originalState','submissionMayHaveOccurred']:[])]);
 const original=originalFor(p,record);
 if(attempted)need(submissionRetirementEligible(original),'INJECTIVE_RECOVERY_SUBMISSION_ONLY');else eligibleUnsent(original);
 const {reviewSha256,...body}=p,b=signedRecoveryBoundary(record);
 need(p.schema===(attempted?SUBMISSION_REVIEW_SCHEMA:RECOVERY_SCHEMA)&&p.recordId===record.id&&p.accountId===record.accountId&&p.transactionHash===record.signed.requestId&&p.recordSha256===recordDigest(record,original.state)&&p.reviewSha256===hash(body)&&canonical(p.boundary)===canonical(b),'INJECTIVE_RECOVERY_REVIEW_BINDING');
 need(p.neverSubmittedByWallet===!attempted&&(!attempted||p.submissionMayHaveOccurred===true)&&p.chainStateAuthenticated===false&&p.settlementVerified===false&&p.automaticRetryAllowed===false,'INJECTIVE_RECOVERY_AUTHORITY');
 need(Number.isSafeInteger(p.observedAt)&&Number.isSafeInteger(p.expiresAt)&&p.expiresAt>p.observedAt&&p.expiresAt<=p.observedAt+MAX_AGE&&p.expiresAt<=p.evidence.blockTimeMs+MAX_AGE,'INJECTIVE_RECOVERY_REVIEW_TIME');
 facts(p.evidence,b,p.observedAt);
 if(fresh)need(Number.isSafeInteger(now)&&now>=p.observedAt&&now<p.expiresAt,'INJECTIVE_RECOVERY_REVIEW_EXPIRED');
 return b;
}
export function validateRetirement(record){
 // A persisted report that says submission/inclusion occurred cannot be rebranded as unsent.
 const attempted=record.state===SUBMISSION_EXPIRED;
 const d=record.retirement;shape(d,['schema','review','confirmation','confirmedAt','check']);
 need(isInjectiveRetired(record.state)&&d.schema===(attempted?SUBMISSION_RETIREMENT_SCHEMA:RETIREMENT_SCHEMA)&&d.review.schema===(attempted?SUBMISSION_REVIEW_SCHEMA:RECOVERY_SCHEMA)&&d.confirmation===d.review.reviewSha256,'INJECTIVE_RETIREMENT_INVALID');
 const b=validateRetirementReview(d.review,record,{fresh:false});
 need(Number.isSafeInteger(d.confirmedAt)&&d.confirmedAt>=d.review.observedAt&&d.confirmedAt<d.review.expiresAt,'INJECTIVE_RECOVERY_REVIEW_EXPIRED');
 facts(d.check,b,d.confirmedAt);
 need(unsigned(d.check.height)>=unsigned(d.review.evidence.height)&&(d.check.height!==d.review.evidence.height||d.check.blockHash===d.review.evidence.blockHash),'INJECTIVE_RECOVERY_BLOCK_CHANGED');
 return d;
}
/** All historical bytes/IDs remain. Only retired predecessors allow a new sequence use. */
export function assertInjectiveSequenceAvailable(records,summary){
 const r=injectiveReviewFromSummary(summary);
 for(const previous of records.filter(x=>x.summary.sequenceKey===summary.sequenceKey)){
  need(isInjectiveRetired(previous.state),'INJECTIVE_SEQUENCE_ALREADY_RESERVED');validateRetirement(previous);
  const c=previous.retirement.check,b=signedRecoveryBoundary(previous);
  need(r.endpoint===b.endpoint&&unsigned(r.anchor.height)>=unsigned(c.height)&&unsigned(r.anchor.height)>unsigned(b.timeoutHeight)&&(r.anchor.height!==c.height||r.anchor.hash===c.blockHash),'INJECTIVE_RECOVERY_ANCHOR_REQUIRED');
 }
}
function header(data){const a=data.block?.header,b=data.sdk_block?.header;need(a||b,'INJECTIVE_RECOVERY_BLOCK_INVALID');if(a&&b)need(a.chain_id===b.chain_id&&a.height===b.height&&a.time===b.time,'INJECTIVE_RECOVERY_BLOCK_INVALID');return a??b;}
function block(data,chainId){const h=header(data);need(h.chain_id===chainId,'INJECTIVE_RECOVERY_CHAIN_CHANGED');unsigned(h.height);
 const s=data.block_id?.hash;let hex;
 if(typeof s==='string'&&/^[a-fA-F0-9]{64}$/.test(s))hex=s.toLowerCase();else{need(typeof s==='string'&&Buffer.from(s,'base64').length===32&&Buffer.from(s,'base64').toString('base64')===s,'INJECTIVE_RECOVERY_BLOCK_INVALID');hex=Buffer.from(s,'base64').toString('hex');}
 need(hex!=='0'.repeat(64)&&typeof h.time==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(h.time),'INJECTIVE_RECOVERY_BLOCK_INVALID');
 const ms=Date.parse(h.time);need(Number.isSafeInteger(ms),'INJECTIVE_RECOVERY_BLOCK_INVALID');return {height:h.height,blockHash:hex,blockTimeMs:ms};
}
function eligibleUnsent(record){need(record.state==='signed'&&!record.retirement,'INJECTIVE_RECOVERY_UNSENT_ONLY');need(!record.report||!record.report.received&&record.report.code===undefined&&record.report.height===undefined&&['NOT_FOUND_DOES_NOT_PROVE_FAILURE','INJECTIVE_RPC_TRANSPORT_UNCERTAIN','INJECTIVE_RPC_HTTP_ERROR'].includes(record.report.reason),'INJECTIVE_RECOVERY_UNSENT_ONLY');}
async function scan(engine,vault,record,guard){
 guard();retirementTarget(record);const b=signedRecoveryBoundary(record),review=injectiveReviewFromSummary(record.summary),query=p=>engine.request(review,p);
 const h=block(await query('/cosmos/base/tendermint/v1beta1/blocks/latest'),b.chainId);guard();
 need(unsigned(h.height)>unsigned(b.timeoutHeight),'INJECTIVE_RECOVERY_NOT_EXPIRED');
 await checkInjectiveContinuity(engine,review,await vault.injectiveRecords(),record.accountId,{requiredHeight:h.height,guard});guard();
 const txPath='/cosmos/tx/v1beta1/txs/'+record.signed.requestId;
 need((await engine.request(review,txPath,{strictNotFound:true})).notFound===true,'INJECTIVE_RECOVERY_RECEIPT_AVAILABLE');guard();
 const ar=await engine.request(review,'/cosmos/auth/v1beta1/accounts/'+b.address,{height:h.height});guard();
 need(ar.account?.['@type']==='/injective.types.v1beta1.EthAccount','INJECTIVE_RECOVERY_ACCOUNT_CHANGED');const a=ar.account.base_account;
 need(a?.address===b.address&&a.account_number===b.accountNumber&&a.sequence===b.sequence,'INJECTIVE_RECOVERY_ACCOUNT_CHANGED');
 if(a.pub_key!==null)need(a.pub_key?.['@type']==='/injective.crypto.v1beta1.ethsecp256k1.PubKey'&&a.pub_key.key===Buffer.from(b.publicKeyHex,'hex').toString('base64'),'INJECTIVE_RECOVERY_ACCOUNT_CHANGED');
 const end=block(await query('/cosmos/base/tendermint/v1beta1/blocks/'+h.height),b.chainId);guard();need(canonical(end)===canonical(h),'INJECTIVE_RECOVERY_BLOCK_CHANGED');
 need((await engine.request(review,txPath,{strictNotFound:true})).notFound===true,'INJECTIVE_RECOVERY_RECEIPT_AVAILABLE');guard();
 await checkInjectiveContinuity(engine,review,await vault.injectiveRecords(),record.accountId,{requiredHeight:h.height,guard});guard();
 const e={...h,accountNumber:a.account_number,sequence:a.sequence,transactionNotFound:true};facts(e,b,engine.now());return e;
}
export async function prepareInjectiveRetirement(engine,vault,candidate,{authorize=()=>{}}={}){
 const epoch=vault.epoch,guard=()=>{authorize();vault.check();need(vault.epoch===epoch,'LOCK_INTERRUPTED_OPERATION');};guard();
 const r=await engine.current(vault,candidate);guard();const e=await scan(engine,vault,r,guard);await engine.current(vault,r);guard();
 const at=engine.now(),body={schema:retirementTarget(r)===SUBMISSION_EXPIRED?SUBMISSION_REVIEW_SCHEMA:RECOVERY_SCHEMA,recordId:r.id,accountId:r.accountId,transactionHash:r.signed.requestId,recordSha256:recordDigest(r,r.state),boundary:signedRecoveryBoundary(r),evidence:e,observedAt:at,expiresAt:Math.min(at+MAX_AGE,e.blockTimeMs+MAX_AGE),neverSubmittedByWallet:r.state==='signed',...(r.state==='signed'?{}:{originalState:r.state,submissionMayHaveOccurred:true}),chainStateAuthenticated:false,settlementVerified:false,automaticRetryAllowed:false};
 const review={...body,reviewSha256:hash(body)};validateRetirementReview(review,r,{now:at});return freeze(review);
}
export async function retireInjectiveExpired(engine,vault,candidate,proposal,confirmation,{authorize=()=>{}}={}){
 // Copy before awaiting: a mutable caller cannot replace the approved review mid-request.
 const p=clone(proposal);need(confirmation===p.reviewSha256,'INJECTIVE_RECOVERY_CONFIRMATION_REQUIRED');
 const epoch=vault.epoch,key=candidate.accountId;need(!engine.active.has(key),'INJECTIVE_OPERATION_BUSY');engine.active.add(key);
 const guard=()=>{authorize();vault.check();need(vault.epoch===epoch,'LOCK_INTERRUPTED_OPERATION');validateRetirementReview(p,candidate,{now:engine.now()});};
 try{guard();const r=await engine.current(vault,candidate);retirementTarget(r);guard();const e=await scan(engine,vault,r,guard);guard();
  return vault.retireInjective(r,{schema:reviewKind(p)?SUBMISSION_RETIREMENT_SCHEMA:RETIREMENT_SCHEMA,review:p,confirmation,confirmedAt:engine.now(),check:e},{authorize:guard});
 }finally{engine.active.delete(key);}
}
/** A new signature/send cannot silently follow a restarted or rolled-back local chain. */
export async function checkRetirementAnchor(engine,records,account,review,height){
 const history=records.filter(r=>r.accountId===account.id&&isInjectiveRetired(r.state));
 if(!history.length)return;
 const last=history.reduce((a,b)=>unsigned(a.retirement.check.height)>=unsigned(b.retirement.check.height)?a:b);
 validateRetirement(last);const b=signedRecoveryBoundary(last),c=last.retirement.check;
 need(review.endpoint===b.endpoint&&review.chainId===b.chainId&&unsigned(height)>=unsigned(c.height)&&unsigned(height)>unsigned(b.timeoutHeight),'INJECTIVE_RECOVERY_CHAIN_ROLLBACK');
 const anchored=block(await engine.request(review,'/cosmos/base/tendermint/v1beta1/blocks/'+c.height),b.chainId);
 need(canonical(anchored)===canonical({height:c.height,blockHash:c.blockHash,blockTimeMs:c.blockTimeMs}),'INJECTIVE_RECOVERY_CHAIN_ROLLBACK');
}

// Backward-compatible symbol; the receipt schema determines the exact expiry mode.
export const retireInjectiveUnsent=retireInjectiveExpired;
