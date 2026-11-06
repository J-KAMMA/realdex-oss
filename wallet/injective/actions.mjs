/** Local owner action preparation/rechecks. Queries/simulation only, never broadcast. */
import * as secp from '../vendor/noble-secp256k1.mjs';
import {need,shape,clone,canonical,uint} from '../lib/guard.mjs';
import {injectiveIdentity,injectiveReviewFromSummary,validateInjectiveReview,INJECTIVE_OPERATION} from './codec.mjs';
import {ACTION_SCHEMA,actionPolicy,actionFee,validateAction,actionTransaction,sealActionReview,checkActionState,checkActionFunding,actionDecimal,U64,localActionEndpoint} from './action-codec.mjs';
import {cmp,shift,exactInt,floor} from '../../node/external/math.mjs';

function publicHex(owner){const secret=Buffer.from(owner.secretHex,'hex');try{return Buffer.from(secp.getPublicKey(secret)).toString('hex');}finally{secret.fill(0);}}
const senderOf=owner=>injectiveIdentity(publicHex(owner));
export function cancelAction(source,owner,payment){
 shape(payment,['requestKey','orderHash','policy']);
 need(source.accountId===owner.id&&source.state==='reported-confirmed'&&source.summary.operation===INJECTIVE_OPERATION,'INJECTIVE_CANCEL_SOURCE_REQUIRED');
 const r=injectiveReviewFromSummary(source.summary);validateInjectiveReview(r,owner,{fresh:false});
 const p=r.plan,id=senderOf(owner);
 return validateAction({kind:'cancel',requestKey:payment.requestKey,sender:id.injectiveAddress,subaccountId:p.input.subaccountId,
  sourceRecordId:source.id,sourceTxHash:source.signed.requestId,sourceReviewSha256:r.reviewSha256,marketId:p.marketId,orderHash:payment.orderHash,
  clientOrderId:p.clientOrderId,side:p.input.side,limitPrice:p.input.limitPrice,quantityAtomic:p.baseQuantityAtomic,baseDenom:p.baseAsset.id.split('/bank:')[1],baseDecimals:p.baseAsset.decimals});
}
export function withdrawAction(owner,payment){
 shape(payment,['requestKey','endpoint','subaccountId','denom','amountAtomic','policy']);
 const id=senderOf(owner);
 return validateAction({kind:'withdraw',requestKey:payment.requestKey,sender:id.injectiveAddress,subaccountId:payment.subaccountId,denom:payment.denom,amountAtomic:payment.amountAtomic,destination:id.injectiveAddress});
}
/** A deposit may target only this owner's explicit nondefault exchange subaccount. */
export function depositAction(owner,payment){
 shape(payment,['requestKey','endpoint','subaccountId','denom','amountAtomic','policy']);
 const id=senderOf(owner);
 return validateAction({kind:'deposit',requestKey:payment.requestKey,sender:id.injectiveAddress,subaccountId:payment.subaccountId,denom:payment.denom,amountAtomic:payment.amountAtomic,destination:payment.subaccountId});
}
function block(raw,now,maxAgeMs,{fresh=true}={}){
 const a=raw.block?.header,b=raw.sdk_block?.header;
 need(a||b,'INJECTIVE_BLOCK_RESPONSE');if(a&&b)need(a.chain_id===b.chain_id&&a.height===b.height&&a.time===b.time,'INJECTIVE_BLOCK_RESPONSE');
 const h=a??b;need(h.chain_id==='injective-888'&&uint(h.height,U64)>0n,'INJECTIVE_CHAIN_CHANGED');
 let hash=raw.block_id?.hash;
 if(typeof hash==='string'&&/^[a-fA-F0-9]{64}$/.test(hash))hash=hash.toLowerCase();
 else {need(typeof hash==='string'&&Buffer.from(hash,'base64').length===32&&Buffer.from(hash,'base64').toString('base64')===hash,'INJECTIVE_ACTION_BLOCK_HASH');hash=Buffer.from(hash,'base64').toString('hex');}
 need(hash!=='0'.repeat(64),'INJECTIVE_ACTION_BLOCK_HASH');
 need(typeof h.time==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(h.time),'INJECTIVE_ACTION_BLOCK_TIME');
 const timeMs=Date.parse(h.time);need(Number.isSafeInteger(timeMs)&&(!fresh||(timeMs<=now+2000&&now-timeMs<=maxAgeMs)),'INJECTIVE_ACTION_BLOCK_STALE');
 return {height:h.height,hash,timeMs,chainId:h.chain_id};
}
const bankPath=(sender,denom)=>'/cosmos/bank/v1beta1/spendable_balances/'+sender+'/by_denom?denom='+encodeURIComponent(denom);
const depositPath=a=>'/injective/exchange/v1beta1/exchange/subaccountDeposit?subaccount_id='+a.subaccountId+'&denom='+encodeURIComponent(a.denom);
const orderPath=a=>'/injective/exchange/v2/spot/orders/'+a.marketId+'/'+a.subaccountId;
async function bank(engine,review,height,denom){
 const raw=await engine.request(review,bankPath(review.action.sender,denom),{height});
 need(raw.balance?.denom===denom,'INJECTIVE_BALANCE_DENOM');return String(uint(raw.balance.amount));
}
function listed(raw,action){
 need(Array.isArray(raw.orders)&&raw.orders.length<=1000,'INJECTIVE_CANCEL_ORDER_LIST');
 const found=raw.orders.filter(o=>o?.order_hash===action.orderHash);
 need(found.length<=1,'INJECTIVE_CANCEL_AMBIGUOUS');return found[0];
}
export async function readActionState(engine,review,height,{gasBalanceAtomic}={}){
 const a=review.action;
 if(a.kind==='cancel'){
  const o=listed(await engine.request(review,orderPath(a),{height}),a);
  need(o,'INJECTIVE_CANCEL_ORDER_NOT_OPEN');
  need(o.cid===a.clientOrderId&&typeof o.isBuy==='boolean','INJECTIVE_CANCEL_TARGET_CHANGED');
  const s={kind:'cancel',orderHash:o.order_hash,clientOrderId:o.cid,quantityAtomic:String(exactInt(shift(actionDecimal(o.quantity),a.baseDecimals))),remainingAtomic:String(exactInt(shift(actionDecimal(o.fillable),a.baseDecimals))),side:o.isBuy?'buy':'sell',limitPrice:o.price};
  checkActionState(a,s);return s;
 }
 const v=(await engine.request(review,depositPath(a),{height})).deposits;
 need(v,'INJECTIVE_DEPOSIT_MISSING');const available=actionDecimal(v.available_balance),total=actionDecimal(v.total_balance);
 need(cmp(available,total)<=0,'INJECTIVE_DEPOSIT_INCONSISTENT');
 const s={kind:a.kind,availableAtomic:String(floor(available)),totalAtomic:String(floor(total)),bankBalanceAtomic:a.kind==='deposit'&&a.denom==='inj'&&gasBalanceAtomic!==undefined?gasBalanceAtomic:await bank(engine,review,height,a.denom)};
 checkActionState(a,s);return s;
}
async function observe(engine,review,owner){
 const {action,policy}=review,now=engine.now();
 const anchor=block(await engine.request(review,'/cosmos/base/tendermint/v1beta1/blocks/latest'),now,policy.maxAgeMs);
 const ar=await engine.request(review,'/cosmos/auth/v1beta1/accounts/'+action.sender,{height:anchor.height});
 need(ar.account?.['@type']==='/injective.types.v1beta1.EthAccount','INJECTIVE_ACCOUNT_TYPE');const a=ar.account.base_account;
 const publicKeyHex=publicHex(owner);
 need(a?.address===action.sender,'INJECTIVE_ACCOUNT_CHANGED');uint(a.account_number,U64);uint(a.sequence,U64);
 if(a.pub_key!==null)need(a.pub_key?.['@type']==='/injective.crypto.v1beta1.ethsecp256k1.PubKey'&&a.pub_key.key===Buffer.from(publicKeyHex,'hex').toString('base64'),'INJECTIVE_ACCOUNT_KEY_CHANGED');
 const account={address:a.address,accountNumber:a.account_number,sequence:a.sequence,publicKeyHex};
 const gasBalanceAtomic=await bank(engine,review,anchor.height,'inj');need(uint(gasBalanceAtomic)>=uint(actionFee(policy)),'INJECTIVE_INSUFFICIENT_GAS');
 const state=await readActionState(engine,review,anchor.height,{gasBalanceAtomic});
 checkActionFunding(action,state,gasBalanceAtomic,policy);
 return {anchor,account,gasBalanceAtomic,state};
}
async function simulate(engine,review,transaction,height){
 const sim=await engine.request(review,'/cosmos/tx/v1beta1/simulate',{height,body:{tx_bytes:transaction.simulationTxBase64}});
 const used=uint(sim.gas_info?.gas_used,U64),wanted=uint(sim.gas_info?.gas_wanted,U64),cap=uint(transaction.fee.gasLimit);
 need(used>0n&&wanted>=used&&used<=cap&&used*BigInt(review.policy.gasMarginBps)<=cap*10000n&&sim.result&&typeof sim.result==='object'&&!Array.isArray(sim.result),'INJECTIVE_SIMULATION_GAS_MARGIN');
 return {gasUsed:String(used),gasWanted:String(wanted)};
}
async function unchangedAnchor(engine,review,anchor){
 const end=block(await engine.request(review,'/cosmos/base/tendermint/v1beta1/blocks/'+anchor.height),engine.now(),review.policy.maxAgeMs);
 need(canonical(end)===canonical(anchor),'INJECTIVE_ACTION_BLOCK_CHANGED');
}
export async function prepareOwnerAction(engine,owner,action,endpoint,policy){
 need(owner?.kind==='local'&&owner.family==='evm','INJECTIVE_OWNER_ACCOUNT_REQUIRED');
 const started=engine.now(),r={schema:ACTION_SCHEMA,chainId:'injective-888',endpoint:localActionEndpoint(endpoint),action:clone(validateAction(action)),policy:actionPolicy(policy)};
 const observed=await observe(engine,r,owner);
 const timeout=String(uint(observed.anchor.height,U64)+BigInt(r.policy.timeoutBlocks));
 const transaction=actionTransaction(r.action,observed.account,r.policy,timeout);
 const simulation=await simulate(engine,r,transaction,observed.anchor.height);await unchangedAnchor(engine,r,observed.anchor);
 const observedAt=engine.now(),expiresAt=Math.min(started+r.policy.maxAgeMs,observed.anchor.timeMs+r.policy.maxAgeMs);
 need(observedAt>=started&&observedAt<expiresAt,'INJECTIVE_REVIEW_EXPIRED');
 const review=sealActionReview({...r,...observed,transaction,simulation,observedAt,expiresAt,readyForOwnerReview:true,ownerApproved:false,chainStateAuthenticated:false,signingEnabled:false,broadcastEnabled:false,executable:false,settlementVerified:false});
 validateInjectiveReview(review,owner,{now:observedAt});return review;
}
export async function recheckOwnerAction(engine,review,owner,{fresh=true}={}){
 validateInjectiveReview(review,owner,{now:engine.now(),fresh});
 const o=await observe(engine,review,owner);
 need(canonical(o.account)===canonical(review.account),'INJECTIVE_ACCOUNT_CHANGED');
 need(BigInt(o.anchor.height)<BigInt(review.transaction.timeoutHeight),'INJECTIVE_TRANSACTION_TIMEOUT');
 // A cancel always cancels the remainder. New fills may REDUCE it, never increase it.
 if(review.action.kind==='cancel')need(uint(o.state.remainingAtomic)<=uint(review.state.remainingAtomic),'INJECTIVE_CANCEL_REMAINDER_GREW');
 const simulation=await simulate(engine,review,review.transaction,o.anchor.height);
 await unchangedAnchor(engine,review,o.anchor);
 return {height:o.anchor.height,...simulation};
}
/** Included transaction and post-state observations stay separate; no settlement proof. */
export async function readActionEffect(engine,review,height){
 const a=review.action;
 const raw=await engine.request(review,'/cosmos/base/tendermint/v1beta1/blocks/'+height);
 const h=block(raw,engine.now(),review.policy.maxAgeMs,{fresh:false});need(h.height===height,'INJECTIVE_QUERY_HEIGHT_MISMATCH');
 if(a.kind==='cancel'){
  const present=Boolean(listed(await engine.request(review,orderPath(a),{height}),a));
  return {kind:'cancel',status:'observed',height,orderPresent:present,independentProof:false};
 }
 const v=(await engine.request(review,depositPath(a),{height})).deposits;need(v,'INJECTIVE_DEPOSIT_MISSING');
 const available=actionDecimal(v.available_balance),total=actionDecimal(v.total_balance);need(cmp(available,total)<=0,'INJECTIVE_DEPOSIT_INCONSISTENT');
 return {kind:a.kind,status:'observed',height,availableAtomic:String(floor(available)),totalAtomic:String(floor(total)),bankBalanceAtomic:await bank(engine,review,height,a.denom),independentProof:false};
}
