/** Pure Injective owner-signing codec. No HTTP, persistence, broadcast, or UI authority. */
import {ECDH,createHash,randomUUID} from 'node:crypto';
import {accountAddress,decodeAccountAddress} from '../codec/bech32.mjs';
import {fieldBytes as bytes} from '../codec/protobuf.mjs';
import {address,keccak256} from '../../node/verified/keccak.mjs';
import {need,shape,canonical,clone,freeze,uint,text} from '../lib/guard.mjs';
import {keyInfo,signDigest,sha256} from '../lib/keys.mjs';
import {fingerprint,canonicalBase64} from '../non-evm/solana-codec.mjs';
import * as secp from '../vendor/noble-secp256k1.mjs';
import {ACTION_SCHEMA,ACTION_OPERATIONS,actionFingerprint,validateActionReview} from './action-codec.mjs';
export const INJECTIVE_OPERATION='injective-spot-order-local';
export const INJECTIVE_NETWORK='injective:injective-888';
export const INJECTIVE_ASSURANCE='single selected loopback Injective node observation; no public consensus or state proof';
const HASH=/^[a-f0-9]{64}$/;const TXHASH=/^[A-F0-9]{64}$/;const PUB=/^(02|03)[a-f0-9]{64}$/;
const sha=x=>createHash('sha256').update(x).digest('hex');
function localEndpoint(value){let u;try{u=new URL(value);}catch{throw Error('INJECTIVE_ENDPOINT_INVALID');}
 need(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password,'INJECTIVE_LOOPBACK_ONLY');return u.origin;
}
export function injectiveIdentity(publicKeyHex){
 need(typeof publicKeyHex==='string'&&PUB.test(publicKeyHex),'INJECTIVE_COMPRESSED_KEY_REQUIRED');
 let uncompressed;try{uncompressed=ECDH.convertKey(Buffer.from(publicKeyHex,'hex'),'secp256k1',undefined,undefined,'uncompressed');}catch{throw Error('INJECTIVE_COMPRESSED_KEY_REQUIRED');}
 const raw=Buffer.from(keccak256(uncompressed.subarray(1)).slice(-40),'hex');
 return {evmAddress:address('0x'+raw.toString('hex')),injectiveAddress:accountAddress('inj',raw)};
}
export const injectiveOperation=review=>review.schema===ACTION_SCHEMA?ACTION_OPERATIONS[review.action?.kind]:INJECTIVE_OPERATION;
/** Common display/request fields; action bytes are independently reconstructed by their validator. */
export function injectiveReviewPlan(review){
 if(review.schema!==ACTION_SCHEMA)return review.plan;
 const a=review.action;
 return {network:review.chainId,requestKey:a.requestKey,planSha256:actionFingerprint(a),
  input:{sender:a.sender,requestKey:a.requestKey,subaccountId:a.subaccountId,side:a.kind==='cancel'?a.side:a.kind,limitPrice:a.kind==='cancel'?a.limitPrice:'not-applicable'},
  marketId:a.kind==='cancel'?a.marketId:a.destination,clientOrderId:a.kind==='cancel'?a.clientOrderId:'not-applicable',
  baseAsset:{symbol:a.kind==='cancel'?a.baseDenom:a.denom},baseQuantityAtomic:a.kind==='cancel'?review.state.remainingAtomic:a.amountAtomic};
}
export function checkInjectiveSummary(summary,review){
 const p=injectiveReviewPlan(review);
 need(summary.operation===injectiveOperation(review)&&summary.networkFrom===p.input.sender&&summary.recipient===p.marketId&&summary.asset===p.baseAsset.symbol&&summary.amountAtomic===p.baseQuantityAtomic&&summary.requestKey===p.requestKey&&summary.planSha256===p.planSha256&&summary.reviewSha256===review.reviewSha256&&summary.feeAtomic===(review.schema===ACTION_SCHEMA?review.transaction.fee.amount:review.costs.gasFeeAtomic)&&summary.sequenceKey===canonical([review.chainId,p.input.sender,review.account.accountNumber,review.account.sequence]),'INJECTIVE_SUMMARY_CHANGED');
 if(review.schema===ACTION_SCHEMA)need(Number.isSafeInteger(summary.expiresAt)&&summary.expiresAt<=review.expiresAt&&summary.expiresAt>review.observedAt&&summary.submissionEnabled===true&&summary.onChainStateVerified===false&&summary.finalityProven===false&&summary.action===review.action.kind&&summary.subaccountId===review.action.subaccountId&&summary.endpoint===review.endpoint&&summary.timeoutHeight===review.transaction.timeoutHeight&&summary.confirmationText===review.reviewSha256&&summary.side===p.input.side&&summary.limitPrice===p.input.limitPrice&&summary.clientOrderId===p.clientOrderId&&summary.marketId===p.marketId,'INJECTIVE_SUMMARY_CHANGED');
 if(review.schema===ACTION_SCHEMA){const a=review.action;need(a.kind==='cancel'?summary.orderHash===a.orderHash&&summary.sourceRecordId===a.sourceRecordId:summary.destination===a.destination,'INJECTIVE_SUMMARY_CHANGED');}
 return true;
}
function planHash(plan){shape(plan,['schema','network','requestKey','clientOrderId','input','marketId','baseAsset','quoteAsset','baseQuantityAtomic','quoteNotionalAtLimit','quoteNotionalCeilingAtomic','message','messageData','observationExpiresAt','orderExpiryOnChain','timeInForce','tradingFeeCapEnforcedOnChain','gasFeeAtomic','marketAuthenticated','inputSha256','snapshotSha256','signingEnabled','broadcastEnabled','executable','blockers','warnings','planSha256']);
 const {planSha256,...body}=plan;need(typeof planSha256==='string'&&HASH.test(planSha256)&&sha(Buffer.from(JSON.stringify(body)))===planSha256,'INJECTIVE_PLAN_INTEGRITY');return planSha256;
}
function reviewHash(review){const {reviewSha256,...body}=review;need(typeof reviewSha256==='string'&&HASH.test(reviewSha256)&&sha(Buffer.from(JSON.stringify(body)))===reviewSha256,'INJECTIVE_REVIEW_INTEGRITY');return reviewSha256;}
export function validateInjectiveReview(review,account,{now=Date.now(),fresh=true}={}){
 if(review?.schema===ACTION_SCHEMA)return validateActionReview(review,account,{now,fresh});
 shape(review,['schema','chainId','queryApiVersion','endpoint','plan','anchor','account','spend','costs','policy','transaction','simulation','observedAt','expiresAt','receipts','readyForOwnerReview','ownerApproved','chainStateAuthenticated','signingEnabled','broadcastEnabled','executable','settlementVerified','blockers','warnings','reviewSha256']);
 need(review.schema==='realdex.injective-preflight.v1'&&review.chainId==='injective-888'&&review.queryApiVersion==='injective.exchange.v2','INJECTIVE_REVIEW_VERSION');
 const endpoint=localEndpoint(review.endpoint);need(endpoint===review.endpoint,'INJECTIVE_ENDPOINT_CANONICAL');reviewHash(review);planHash(review.plan);
 need(review.plan.network===review.chainId&&review.plan.executable===false&&review.plan.signingEnabled===false&&review.plan.broadcastEnabled===false,'INJECTIVE_PLAN_AUTHORITY');
 need(review.readyForOwnerReview===true&&[review.ownerApproved,review.chainStateAuthenticated,review.signingEnabled,review.broadcastEnabled,review.executable,review.settlementVerified].every(v=>v===false),'INJECTIVE_REVIEW_AUTHORITY');
 need(account?.family==='evm'&&account.kind==='local'&&typeof account.address==='string','INJECTIVE_OWNER_ACCOUNT_REQUIRED');
 shape(review.account,['address','accountNumber','sequence','publicKeyHex']);const id=injectiveIdentity(review.account.publicKeyHex);
 need(id.evmAddress===account.address&&id.injectiveAddress===review.account.address&&review.plan.input?.sender===id.injectiveAddress,'INJECTIVE_OWNER_BINDING');
 need(review.plan.input.requestKey===review.plan.requestKey,'INJECTIVE_INPUT_BINDING_INVALID');
 need(typeof review.plan.input.subaccountId==='string'&&/^0x[a-f0-9]{64}$/.test(review.plan.input.subaccountId),'INJECTIVE_SUBACCOUNT_INVALID');
 const senderRaw=decodeAccountAddress(review.plan.input.sender,'inj');
 need(review.plan.input.subaccountId.slice(2,42)===senderRaw.toString('hex'),'INJECTIVE_SUBACCOUNT_OWNER');
 const accountNumber=String(uint(review.account.accountNumber,(1n<<64n)-1n)),sequence=String(uint(review.account.sequence,(1n<<64n)-1n));
 shape(review.transaction,['bodyBytesBase64','authInfoBytesBase64','signDocBase64','simulationTxBase64','timeoutHeight','signMode','fee','signatures']);
 const body=canonicalBase64(review.transaction.bodyBytesBase64,131072),auth=canonicalBase64(review.transaction.authInfoBytesBase64,131072),signDoc=canonicalBase64(review.transaction.signDocBase64,262144),sim=canonicalBase64(review.transaction.simulationTxBase64,262144);
 need(body.length>0&&auth.length>0&&signDoc.length>0&&sim.length>0&&review.transaction.signMode==='SIGN_MODE_DIRECT'&&Array.isArray(review.transaction.signatures)&&review.transaction.signatures.length===0,'INJECTIVE_UNSIGNED_TX_REQUIRED');
 shape(review.transaction.fee,['denom','amount','gasLimit']);need(review.transaction.fee.denom==='inj');uint(review.transaction.fee.amount);uint(review.transaction.fee.gasLimit,10000000n);const timeoutHeight=String(uint(review.transaction.timeoutHeight,(1n<<64n)-1n));need(BigInt(timeoutHeight)>0n,'INJECTIVE_TIMEOUT_REQUIRED');
 shape(review.anchor,['height','hash','time','timeMs','chainId']);need(review.anchor.chainId===review.chainId&&HASH.test(review.anchor.hash));uint(review.anchor.height,(1n<<64n)-1n);
 need(Number.isSafeInteger(review.observedAt)&&Number.isSafeInteger(review.expiresAt)&&review.observedAt<=review.expiresAt,'INJECTIVE_REVIEW_TIME');if(fresh)need(Number.isSafeInteger(now)&&now>=review.observedAt&&now<review.expiresAt,'INJECTIVE_REVIEW_EXPIRED');
 need(Array.isArray(review.blockers)&&review.blockers.includes('OWNER_APPROVAL_AND_SIGNER_REQUIRED')&&Array.isArray(review.receipts)&&Array.isArray(review.warnings),'INJECTIVE_REVIEW_EVIDENCE');
 return freeze({endpoint,publicKeyHex:review.account.publicKeyHex,accountNumber,sequence,timeoutHeight,bodyBytes:body.length,authBytes:auth.length,signDocBytes:signDoc.length,simulationBytes:sim.length});
}

export function injectiveReviewFromSummary(summary,{requireObject=false}={}){
 need(summary&&typeof summary==='object'&&typeof summary.reviewJson==='string'&&summary.reviewJson.length>0&&summary.reviewJson.length<=262144,'INJECTIVE_REVIEW_SERIALIZATION');let review;try{review=JSON.parse(summary.reviewJson);}catch{throw Error('INJECTIVE_REVIEW_SERIALIZATION');}
 if(requireObject){need(summary.review&&canonical(review)===canonical(summary.review),'INJECTIVE_REVIEW_SERIALIZATION');}
 else if(summary.review!==undefined)need(canonical(review)===canonical(summary.review),'INJECTIVE_REVIEW_SERIALIZATION');
 return review;
}
export function makeInjectiveIntent(account,review,{now=Date.now}={}){
 validateInjectiveReview(review,account,{now:now(),fresh:true});
 const p=injectiveReviewPlan(review),createdAt=now(),expiresAt=Math.min(review.expiresAt,createdAt+90000),payment={family:'injective',networkId:INJECTIVE_NETWORK,accountId:account.id,requestKey:p.requestKey,reviewSha256:review.reviewSha256,planSha256:p.planSha256};
 const paymentHash=fingerprint(payment);const reviewJson=JSON.stringify(review);const summary={family:'injective',operation:injectiveOperation(review),networkId:INJECTIVE_NETWORK,chainId:review.chainId,from:account.address,networkFrom:p.input.sender,recipient:p.marketId,asset:p.baseAsset.symbol,amountAtomic:p.baseQuantityAtomic,feeAtomic:review.schema===ACTION_SCHEMA?review.transaction.fee.amount:review.costs.gasFeeAtomic,feeAsset:'INJ',requestKey:p.requestKey,paymentHash,reviewSha256:review.reviewSha256,planSha256:p.planSha256,sequenceKey:canonical([review.chainId,p.input.sender,review.account.accountNumber,review.account.sequence]),clientOrderId:p.clientOrderId,marketId:p.marketId,side:p.input.side,limitPrice:p.input.limitPrice,timeoutHeight:review.transaction.timeoutHeight,endpoint:review.endpoint,confirmationText:review.reviewSha256,submissionEnabled:true,onChainStateVerified:false,finalityProven:false,assurance:INJECTIVE_ASSURANCE,expiresAt,review:clone(review),reviewJson,...(review.schema===ACTION_SCHEMA?{action:review.action.kind,subaccountId:review.action.subaccountId,...(review.action.kind==='cancel'?{orderHash:review.action.orderHash,sourceRecordId:review.action.sourceRecordId}:{destination:review.action.destination})}:{})};
 const intent={family:'injective',accountId:account.id,networkId:INJECTIVE_NETWORK,payment:{...payment,paymentHash},createdAt,expiresAt,salt:randomUUID(),summary};intent.id=fingerprint(intent);return freeze(intent);
}
export function verifyInjectiveIntent(intent,account,{now=Date.now(),fresh=true}={}){
 shape(intent,['family','accountId','networkId','payment','createdAt','expiresAt','salt','summary','id']);need(intent.family==='injective'&&intent.networkId===INJECTIVE_NETWORK&&intent.accountId===account.id,'INJECTIVE_INTENT_BINDING');
 const {id,...body}=intent;need(fingerprint(body)===id,'INJECTIVE_INTENT_CHANGED');if(fresh)need(now>=intent.createdAt&&now<intent.expiresAt,'INJECTIVE_INTENT_EXPIRED');
 const s=intent.summary,review=injectiveReviewFromSummary(s,{requireObject:true});need(s.family==='injective'&&s.operation===injectiveOperation(review)&&s.from===account.address&&s.requestKey===intent.payment.requestKey&&s.reviewSha256===intent.payment.reviewSha256&&s.paymentHash===intent.payment.paymentHash,'INJECTIVE_INTENT_SUMMARY');
 validateInjectiveReview(review,account,{now:fresh?now:0,fresh});need(review.reviewSha256===s.reviewSha256&&injectiveReviewPlan(review).planSha256===s.planSha256&&s.confirmationText===s.reviewSha256,'INJECTIVE_INTENT_REVIEW_MISMATCH');checkInjectiveSummary(s,review);return true;
}
export function signInjectiveIntent(secret,intent,account){
 verifyInjectiveIntent(intent,account,{now:Date.now(),fresh:false});need(Buffer.isBuffer(secret)&&secret.length===32,'KEY_LENGTH_INVALID');const info=keyInfo('evm',secret);need(info.address===account.address,'INJECTIVE_SIGNER_MISMATCH');
 const pub=Buffer.from(secp.getPublicKey(secret)).toString('hex');need(pub===intent.summary.review.account.publicKeyHex,'INJECTIVE_PUBLIC_KEY_CHANGED');
 const review=injectiveReviewFromSummary(intent.summary,{requireObject:true}),signDoc=Buffer.from(review.transaction.signDocBase64,'base64'),digest=Buffer.from(keccak256(signDoc).slice(2),'hex'),sig=signDigest(secret,digest),signature=Buffer.concat([Buffer.from(sig.toCompactRawBytes()),Buffer.from([sig.recovery])]);
 const raw=Buffer.concat([bytes(1,Buffer.from(review.transaction.bodyBytesBase64,'base64')),bytes(2,Buffer.from(review.transaction.authInfoBytesBase64,'base64')),bytes(3,signature)]),requestId=sha256(raw).toString('hex').toUpperCase();
 return {format:'injective-ethsecp256k1-direct-v1',signatureBase64:signature.toString('base64'),publicKeyHex:pub,signDocKeccak256:'0x'+digest.toString('hex'),txRawBase64:raw.toString('base64'),requestId,reviewSha256:intent.summary.reviewSha256};
}
export function verifyInjectiveSigned(s,summary,account){
 shape(s,['format','signatureBase64','publicKeyHex','signDocKeccak256','txRawBase64','requestId','reviewSha256']);need(s.format==='injective-ethsecp256k1-direct-v1'&&s.reviewSha256===summary.reviewSha256&&PUB.test(s.publicKeyHex)&&TXHASH.test(s.requestId),'INJECTIVE_SIGNED_FORMAT');
 const id=injectiveIdentity(s.publicKeyHex);need(id.evmAddress===account.address&&id.injectiveAddress===summary.networkFrom,'INJECTIVE_SIGNED_OWNER');
 const review=injectiveReviewFromSummary(summary);validateInjectiveReview(review,account,{fresh:false});checkInjectiveSummary(summary,review);const sig=canonicalBase64(s.signatureBase64,65);need(sig.length===65&&[0,1].includes(sig[64]),'INJECTIVE_SIGNATURE_ENCODING');const compact=sig.subarray(0,64),doc=Buffer.from(review.transaction.signDocBase64,'base64'),digest=Buffer.from(keccak256(doc).slice(2),'hex');
 need(s.signDocKeccak256==='0x'+digest.toString('hex')&&secp.verify(compact,digest,Buffer.from(s.publicKeyHex,'hex'),{lowS:true}),'INJECTIVE_SIGNATURE_INVALID');
 const recovered=secp.Signature.fromCompact(compact).addRecoveryBit(sig[64]).recoverPublicKey(digest).toRawBytes(true);need(Buffer.from(recovered).toString('hex')===s.publicKeyHex,'INJECTIVE_SIGNATURE_RECOVERY');
 const raw=Buffer.concat([bytes(1,Buffer.from(review.transaction.bodyBytesBase64,'base64')),bytes(2,Buffer.from(review.transaction.authInfoBytesBase64,'base64')),bytes(3,sig)]);
 need(s.txRawBase64===raw.toString('base64')&&s.requestId===sha256(raw).toString('hex').toUpperCase(),'INJECTIVE_TX_RAW_MISMATCH');return true;
}
