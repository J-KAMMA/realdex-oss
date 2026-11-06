/** Owner-bound cancel/withdraw/deposit reviews. Pure encoding; no network, storage or signer. */
import {createHash,ECDH} from 'node:crypto';
import {need,shape,canonical,freeze,uint,text} from '../lib/guard.mjs';
import {decodeAccountAddress,accountAddress} from '../codec/bech32.mjs';
import {fieldBytes as bytes,fieldText as field,fieldUint as num,anyMessage} from '../codec/protobuf.mjs';
import {keccak256} from '../../node/verified/keccak.mjs';
import {decimal,cmp,rational,mul,ceil,small} from '../../node/external/math.mjs';
import {prepareInjectiveCancelOrder} from '../../node/external/injective-orders.mjs';

export const ACTION_SCHEMA='realdex.injective-owner-action-review.v1';
export const ACTION_OPERATIONS=Object.freeze({cancel:'injective-spot-cancel-local',withdraw:'injective-withdraw-local',deposit:'injective-deposit-local'});
export const U64=(1n<<64n)-1n;
const HASH=/^[a-f0-9]{64}$/, TXHASH=/^[A-F0-9]{64}$/, PUB=/^(02|03)[a-f0-9]{64}$/;
export const actionFingerprint=x=>createHash('sha256').update(canonical(x)).digest('hex');
const reviewHash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const join=(...parts)=>Buffer.concat(parts);
export function localActionEndpoint(value){
 let u;try{u=new URL(value);}catch{throw Error('INJECTIVE_ENDPOINT_INVALID');}
 need(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password,'INJECTIVE_LOOPBACK_ONLY');
 return u.origin;
}
export function actionDecimal(s){
 need(typeof s==='string'&&s.length<=90&&/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(s),'INJECTIVE_ACTION_DECIMAL');
 return decimal(s);
}
export function actionPolicy(p){
 shape(p,['gasLimit','gasPriceAtomic','maxGasFeeAtomic','gasMarginBps','timeoutBlocks','maxAgeMs']);
 const gas=uint(p.gasLimit,10000000n),price=actionDecimal(p.gasPriceAtomic);
 need(gas>0n&&price.n>0n&&cmp(price,rational(10n**18n))<=0,'INJECTIVE_ACTION_GAS_POLICY');
 const fee=ceil(mul(price,rational(gas)));need(fee<=uint(p.maxGasFeeAtomic),'INJECTIVE_ACTION_FEE_CAP');
 const gasMarginBps=small(p.gasMarginBps,30000),timeoutBlocks=small(p.timeoutBlocks,100),maxAgeMs=small(p.maxAgeMs,30000);
 need(gasMarginBps>=10000&&timeoutBlocks>0&&maxAgeMs>=1000,'INJECTIVE_ACTION_GAS_POLICY');
 return {gasLimit:p.gasLimit,gasPriceAtomic:p.gasPriceAtomic,maxGasFeeAtomic:p.maxGasFeeAtomic,gasMarginBps,timeoutBlocks,maxAgeMs};
}
export function actionFee(policy){return String(ceil(mul(actionDecimal(policy.gasPriceAtomic),rational(uint(policy.gasLimit)))));}
export function validateAction(action){
 need(action&&Object.hasOwn(ACTION_OPERATIONS,action.kind),'INJECTIVE_ACTION_UNSUPPORTED');
 const common=['kind','requestKey','sender','subaccountId'];
 shape(action,action.kind==='cancel'?[...common,'sourceRecordId','sourceTxHash','sourceReviewSha256','marketId','orderHash','clientOrderId','side','limitPrice','quantityAtomic','baseDenom','baseDecimals']:[...common,'denom','amountAtomic','destination']);
 need(typeof action.requestKey==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(action.requestKey),'INJECTIVE_ACTION_REQUEST_KEY');
 const raw=decodeAccountAddress(action.sender,'inj');
 need(raw.length===20&&!raw.equals(Buffer.alloc(20))&&accountAddress('inj',raw)===action.sender,'INJECTIVE_ACTION_SENDER');
 need(typeof action.subaccountId==='string'&&/^0x[a-f0-9]{64}$/.test(action.subaccountId)&&action.subaccountId.slice(2,42)===raw.toString('hex'),'INJECTIVE_ACTION_SUBACCOUNT_OWNER');
 if(action.kind==='cancel'){
  text(action.sourceRecordId,80);need(TXHASH.test(action.sourceTxHash)&&HASH.test(action.sourceReviewSha256),'INJECTIVE_ACTION_SOURCE');
  need(/^0x[a-f0-9]{64}$/.test(action.marketId)&&/^0x[a-f0-9]{64}$/.test(action.orderHash)&&action.orderHash!=='0x'+'0'.repeat(64),'INJECTIVE_ACTION_ORDER_HASH');
  need(/^rdx-[a-f0-9]{32}$/.test(action.clientOrderId)&&['buy','sell'].includes(action.side),'INJECTIVE_ACTION_ORDER');
  need(actionDecimal(action.limitPrice).n>0n&&uint(action.quantityAtomic)>0n,'INJECTIVE_ACTION_ORDER');
  need(Number.isSafeInteger(action.baseDecimals)&&action.baseDecimals>=0&&action.baseDecimals<=36,'INJECTIVE_ACTION_DECIMALS');
  denom(action.baseDenom);
 }else{
  const deposit=action.kind==='deposit';
  need(action.subaccountId.slice(-24)!=='0'.repeat(24),deposit?'INJECTIVE_DEPOSIT_NONDEFAULT_REQUIRED':'INJECTIVE_WITHDRAW_NONDEFAULT_REQUIRED');
  denom(action.denom);need(uint(action.amountAtomic)>0n,deposit?'INJECTIVE_DEPOSIT_AMOUNT':'INJECTIVE_WITHDRAW_AMOUNT');
  need(action.destination===(deposit?action.subaccountId:action.sender),deposit?'INJECTIVE_DEPOSIT_SELF_ONLY':'INJECTIVE_WITHDRAW_SELF_ONLY');
 }
 return action;
}
export function denom(d){need(typeof d==='string'&&/^[A-Za-z][A-Za-z0-9/:._-]{2,127}$/.test(d),'INJECTIVE_ACTION_DENOM');return d;}
export function actionMessage(action){
 validateAction(action);
 if(action.kind==='cancel')return prepareInjectiveCancelOrder({sender:action.sender,marketId:action.marketId,subaccountId:action.subaccountId,orderHash:action.orderHash}).message;
 const typeUrl=action.kind==='deposit'?'/injective.exchange.v1beta1.MsgDeposit':'/injective.exchange.v1beta1.MsgWithdraw';
 const value=join(field(1,action.sender),field(2,action.subaccountId),bytes(3,join(field(1,action.denom),field(2,action.amountAtomic))));
 return {typeUrl,valueBase64:value.toString('base64'),anyBase64:anyMessage(typeUrl,value).toString('base64')};
}
export function actionTransaction(action,account,policy,timeoutHeight){
 const message=actionMessage(action),fee=actionFee(policy);
 const body=join(bytes(1,Buffer.from(message.anyBase64,'base64')),num(3,uint(timeoutHeight,U64)));
 const pub=anyMessage('/injective.crypto.v1beta1.ethsecp256k1.PubKey',bytes(1,Buffer.from(account.publicKeyHex,'hex')));
 const signer=join(bytes(1,pub),bytes(2,bytes(1,num(1,1n))),num(3,uint(account.sequence,U64)));
 const auth=join(bytes(1,signer),bytes(2,join(bytes(1,join(field(1,'inj'),field(2,fee))),num(2,uint(policy.gasLimit,10000000n)))));
 const signDoc=join(bytes(1,body),bytes(2,auth),field(3,'injective-888'),num(4,uint(account.accountNumber,U64)));
 const simulation=join(bytes(1,body),bytes(2,auth),bytes(3,Buffer.alloc(0)));
 return {bodyBytesBase64:body.toString('base64'),authInfoBytesBase64:auth.toString('base64'),signDocBase64:signDoc.toString('base64'),simulationTxBase64:simulation.toString('base64'),
  timeoutHeight,signMode:'SIGN_MODE_DIRECT',fee:{denom:'inj',amount:fee,gasLimit:policy.gasLimit},signatures:[]};
}
export function checkActionState(action,state){
 if(action.kind==='cancel'){
  shape(state,['kind','orderHash','clientOrderId','quantityAtomic','remainingAtomic','side','limitPrice']);
  need(state.kind==='cancel'&&state.orderHash===action.orderHash&&state.clientOrderId===action.clientOrderId&&state.quantityAtomic===action.quantityAtomic&&state.side===action.side&&cmp(actionDecimal(state.limitPrice),actionDecimal(action.limitPrice))===0,'INJECTIVE_CANCEL_TARGET_CHANGED');
  const remaining=uint(state.remainingAtomic);need(remaining>0n&&remaining<=uint(action.quantityAtomic),'INJECTIVE_CANCEL_REMAINDER');
 }else{
  shape(state,['kind','availableAtomic','totalAtomic','bankBalanceAtomic']);need(state.kind===action.kind,'INJECTIVE_ACTION_STATE');
  need(uint(state.availableAtomic)<=uint(state.totalAtomic),'INJECTIVE_DEPOSIT_INCONSISTENT');uint(state.bankBalanceAtomic);
  need(uint(action.kind==='deposit'?state.bankBalanceAtomic:state.availableAtomic)>=uint(action.amountAtomic),action.kind==='deposit'?'INJECTIVE_DEPOSIT_INSUFFICIENT':'INJECTIVE_WITHDRAW_INSUFFICIENT');
 }
}
/** Gas is paid from bank INJ. Deposit INJ and its fee must fit ONE spendable balance. */
export function checkActionFunding(action,state,gasBalanceAtomic,policy){
 checkActionState(action,state);const gas=uint(gasBalanceAtomic),fee=uint(actionFee(policy));
 need(gas>=fee,'INJECTIVE_INSUFFICIENT_GAS');
 if(action.kind==='deposit'&&action.denom==='inj'){
  need(state.bankBalanceAtomic===gasBalanceAtomic,'INJECTIVE_DEPOSIT_GAS_BALANCE_MISMATCH');
  need(uint(action.amountAtomic)+fee<=gas,'INJECTIVE_DEPOSIT_INSUFFICIENT_WITH_GAS');
 }
}
export function sealActionReview(body){return freeze({...body,reviewSha256:reviewHash(body)});}
export function validateActionReview(review,owner,{now=Date.now(),fresh=true}={}){
 shape(review,['schema','chainId','endpoint','action','account','anchor','policy','state','gasBalanceAtomic','transaction','simulation','observedAt','expiresAt','readyForOwnerReview','ownerApproved','chainStateAuthenticated','signingEnabled','broadcastEnabled','executable','settlementVerified','reviewSha256']);
 need(review.schema===ACTION_SCHEMA&&review.chainId==='injective-888','INJECTIVE_ACTION_VERSION');
 need(localActionEndpoint(review.endpoint)===review.endpoint,'INJECTIVE_ENDPOINT_CANONICAL');
 const {reviewSha256,...body}=review;need(HASH.test(reviewSha256)&&reviewHash(body)===reviewSha256,'INJECTIVE_REVIEW_INTEGRITY');
 const a=validateAction(review.action),p=actionPolicy(review.policy);need(canonical(p)===canonical(review.policy),'INJECTIVE_ACTION_POLICY_CANONICAL');
 shape(review.account,['address','accountNumber','sequence','publicKeyHex']);const ac=review.account;uint(ac.accountNumber,U64);uint(ac.sequence,U64);
 need(PUB.test(ac.publicKeyHex),'INJECTIVE_PUBLIC_KEY');let pub;try{pub=ECDH.convertKey(Buffer.from(ac.publicKeyHex,'hex'),'secp256k1',undefined,undefined,'uncompressed');}catch{throw Error('INJECTIVE_PUBLIC_KEY');}
 const evm='0x'+keccak256(pub.subarray(1)).slice(-40);const inj=accountAddress('inj',Buffer.from(evm.slice(2),'hex'));
 need(owner?.family==='evm'&&owner.kind==='local'&&owner.address===evm&&inj===ac.address&&a.sender===inj,'INJECTIVE_OWNER_BINDING');
 shape(review.anchor,['height','hash','timeMs','chainId']);const h=uint(review.anchor.height,U64);need(h>0n&&review.anchor.chainId===review.chainId&&HASH.test(review.anchor.hash)&&review.anchor.hash!=='0'.repeat(64),'INJECTIVE_ACTION_ANCHOR');
 need(Number.isSafeInteger(review.anchor.timeMs)&&Number.isSafeInteger(review.observedAt)&&Number.isSafeInteger(review.expiresAt)&&review.observedAt>0&&review.observedAt<=review.expiresAt&&review.anchor.timeMs<=review.observedAt+2000&&review.observedAt-review.anchor.timeMs<=p.maxAgeMs&&review.expiresAt<=review.anchor.timeMs+p.maxAgeMs&&review.expiresAt<=review.observedAt+p.maxAgeMs,'INJECTIVE_ACTION_TIME');
 if(fresh)need(Number.isSafeInteger(now)&&now>=review.observedAt&&now<review.expiresAt,'INJECTIVE_REVIEW_EXPIRED');
 const timeout=String(h+BigInt(p.timeoutBlocks));need(BigInt(timeout)<=U64&&canonical(actionTransaction(a,ac,p,timeout))===canonical(review.transaction),'INJECTIVE_ACTION_TX_MISMATCH');
 checkActionFunding(a,review.state,review.gasBalanceAtomic,p);
 shape(review.simulation,['gasUsed','gasWanted']);const used=uint(review.simulation.gasUsed,U64),wanted=uint(review.simulation.gasWanted,U64),gas=uint(p.gasLimit);
 need(used>0n&&used<=wanted&&used<=gas&&used*BigInt(p.gasMarginBps)<=gas*10000n,'INJECTIVE_SIMULATION_GAS_MARGIN');
 need(review.readyForOwnerReview===true&&[review.ownerApproved,review.chainStateAuthenticated,review.signingEnabled,review.broadcastEnabled,review.executable,review.settlementVerified].every(v=>v===false),'INJECTIVE_REVIEW_AUTHORITY');
 return freeze({endpoint:review.endpoint,publicKeyHex:ac.publicKeyHex,accountNumber:ac.accountNumber,sequence:ac.sequence,timeoutHeight:timeout});
}
