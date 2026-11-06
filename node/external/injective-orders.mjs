/** Unsigned Injective v1beta1 spot messages. Not a signer or broadcast capability.
 * Market metadata is an indexer observation; none of these checks authenticate it.
 * A GTC order can rest and fill partially. Quote expiry does not expire an order.
 */
import {createHash} from 'node:crypto';
import {fieldText,fieldBytes,fieldUint,anyMessage} from '../../wallet/codec/protobuf.mjs';
import {decodeAccountAddress,accountAddress} from '../../wallet/codec/bech32.mjs';
import {need,uint,small,decimal,shift,exactInt,unpack,multiple,cmp,mul,rational,ceil,pack,timestamp} from './math.mjs';
const sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const schema='realdex.injective-unsigned-order.v1';
const fields=(o,keys)=>need(o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k)),'INJ_ORDER_FIELDS');
function address(s){need(typeof s==='string'&&s===s.toLowerCase(),'INJ_ADDRESS_CANONICAL');const raw=decodeAccountAddress(s,'inj');need(!raw.equals(Buffer.alloc(20))&&accountAddress('inj',raw)===s,'INJ_ADDRESS');return raw;}
function hash32(s){need(typeof s==='string'&&/^0x[0-9a-f]{64}$/.test(s),'INJ_HASH32');return s;}
function userDecimal(s){need(typeof s==='string'&&s.length<=80&&/^(0|[1-9][0-9]*)(\.[0-9]{1,36})?$/.test(s),'INJ_PLAIN_DECIMAL_REQUIRED');return decimal(s);}
function requestKey(s){need(typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(s),'INJ_REQUEST_KEY');return s;}
function sdkDec(value){const n=exactInt(shift(value,18));need(n>=0n&&n<(1n<<255n),'INJ_SDK_DEC_RANGE');return n.toString();}
function envelope(type,value){return {typeUrl:type,valueBase64:value.toString('base64'),anyBase64:anyMessage(type,value).toString('base64')};}
export function prepareInjectiveLimitOrder(snapshot,input,{now=Date.now()}={}) {
  fields(input,['requestKey','sender','subaccountId','side','quantity','limitPrice']);
  need(snapshot?.schema==='realdex.external-spot-snapshot.v1'&&snapshot.executable===false&&snapshot.market?.provider==='injective','INJ_SPOT_SNAPSHOT_REQUIRED');
  const received=timestamp(snapshot.receivedAt),expires=timestamp(snapshot.expiresAt);now=timestamp(now);
  need(now>=received&&now<=expires&&expires-received<=300000,'INJ_OBSERVATION_EXPIRED');
  const m=snapshot.market;need(m.schema==='realdex.external-spot-market.v1'&&m.minNotionalKnown===true,'INJ_MARKET_REQUIREMENTS_UNKNOWN');
  hash32(m.id);need(typeof m.network==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(m.network),'INJ_NETWORK');
  for(const asset of [m.base,m.quote])need(typeof asset?.id==='string'&&asset.id.startsWith(`injective:${m.network}/bank:`),'INJ_ASSET_ID');
  need(m.base.id!==m.quote.id,'INJ_IDENTICAL_ASSETS');
  const key=requestKey(input.requestKey),senderBytes=address(input.sender),sub=hash32(input.subaccountId);
  need(sub.slice(2,42)===senderBytes.toString('hex'),'INJ_SUBACCOUNT_OWNER_MISMATCH');
  need(['buy','sell'].includes(input.side),'INJ_LIMIT_SPOT_ONLY');
  const baseDecimals=small(m.base.decimals),quoteDecimals=small(m.quote.decimals);
  const amount=exactInt(shift(userDecimal(input.quantity),baseDecimals)),lot=uint(m.lotAtomic),price=shift(userDecimal(input.limitPrice),quoteDecimals-baseDecimals);
  need(amount>0n&&amount<(1n<<255n)&&lot>0n&&amount%lot===0n,'INJ_QUANTITY_TICK');
  need(price.n>0n&&multiple(price,unpack(m.priceTick)),'INJ_PRICE_TICK');
  const notional=mul(price,rational(amount)),minimum=unpack(m.minNotionalQuote);
  need(cmp(notional,minimum)>=0,'INJ_MINIMUM_NOTIONAL');
  const cid='rdx-'+sha([m.network,input.sender,key]).slice(0,32);
  // LegacyDec protobuf strings have one additional 18-decimal scaling beyond
  // the market's quote-atoms/base-atoms price and base-atom quantity.
  const data={sender:input.sender,order:{marketId:m.id,orderInfo:{subaccountId:sub,feeRecipient:input.sender,
    price:sdkDec(price),quantity:sdkDec(rational(amount)),cid},orderType:input.side==='buy'?1:2,triggerPrice:'0'}};
  const oi=data.order.orderInfo;
  const info=Buffer.concat([fieldText(1,oi.subaccountId),fieldText(2,oi.feeRecipient),fieldText(3,oi.price),fieldText(4,oi.quantity),fieldText(5,cid)]);
  const order=Buffer.concat([fieldText(1,m.id),fieldBytes(2,info),fieldUint(3,BigInt(data.order.orderType)),fieldText(4,'0')]);
  const value=Buffer.concat([fieldText(1,input.sender),fieldBytes(2,order)]);
  const canonicalInput={requestKey:key,sender:input.sender,subaccountId:sub,side:input.side,quantity:input.quantity,limitPrice:input.limitPrice};
  const result={schema,network:m.network,requestKey:key,clientOrderId:cid,input:canonicalInput,
    marketId:m.id,baseAsset:structuredClone(m.base),quoteAsset:structuredClone(m.quote),baseQuantityAtomic:amount.toString(),
    quoteNotionalAtLimit:pack(notional),quoteNotionalCeilingAtomic:ceil(notional).toString(),
    message:envelope('/injective.exchange.v1beta1.MsgCreateSpotLimitOrder',value),messageData:data,
    observationExpiresAt:expires,orderExpiryOnChain:null,timeInForce:'GTC',
    tradingFeeCapEnforcedOnChain:false,gasFeeAtomic:null,marketAuthenticated:false,
    inputSha256:sha(canonicalInput),snapshotSha256:sha(snapshot),
    signingEnabled:false,broadcastEnabled:false,executable:false,
    blockers:['ACCOUNT_STATE_AND_MARKET_AUTHENTICATION_REQUIRED','ACTUAL_FEE_AND_GAS_CHECK_REQUIRED','OWNER_SIGNER_NOT_CONNECTED','LIVE_VENUE_ACCEPTANCE_NOT_TESTED'],
    warnings:['ORDER_CAN_REST_AND_PARTIALLY_FILL','OBSERVATION_EXPIRY_IS_NOT_ORDER_EXPIRY','CANCELLATION_REQUIRES_CONFIRMED_CHAIN_RESULT']};
  return {...result,planSha256:sha(result)};
}

/** Cancellation is a separate unsigned message; it never reports cancelled funds. */
export function prepareInjectiveCancelOrder(input) {
  fields(input,['sender','marketId','subaccountId','orderHash']);
  const {sender,marketId,subaccountId,orderHash}=input;
  const raw=address(sender);hash32(marketId);hash32(subaccountId);hash32(orderHash);
  need(subaccountId.slice(2,42)===raw.toString('hex'),'INJ_SUBACCOUNT_OWNER_MISMATCH');
  need(orderHash!=='0x'+'00'.repeat(32),'INJ_EMPTY_ORDER_HASH');
  const value=Buffer.concat([fieldText(1,sender),fieldText(2,marketId),fieldText(3,subaccountId),fieldText(4,orderHash)]);
  return {schema:'realdex.injective-unsigned-cancel.v1',sender,marketId,subaccountId,orderHash,
    message:envelope('/injective.exchange.v1beta1.MsgCancelSpotOrder',value),
    signingEnabled:false,broadcastEnabled:false,executable:false,cancelled:false,
    warnings:['FILLS_CAN_RACE_WITH_CANCEL','CANCEL_SUBMISSION_IS_NOT_CANCELLATION_CONFIRMATION']};
}

/** Pure order accounting: candidates / API acceptance are not settled fills. */
export function orderProgress(plan,{filledBaseAtomic,status}) {
  need(plan?.schema===schema&&plan.executable===false,'INJ_ORDER_PLAN');
  const total=uint(plan.baseQuantityAtomic),filled=uint(filledBaseAtomic);need(filled<=total,'INJ_OVERFILL');
  need(['open','filled','cancel-pending','cancelled','unknown'].includes(status),'INJ_ORDER_STATUS');
  need(status!=='filled'||filled===total,'INJ_INCOMPLETE_FILL');
  need(!['open','cancel-pending'].includes(status)||filled<total,'INJ_TERMINAL_FILL');
  const remaining=total-filled,terminal=status==='filled'||status==='cancelled';
  return {filledBaseAtomic:String(filled),remainingBaseAtomic:String(remaining),status,reportedTerminal:terminal,
    remainingCanRest:status==='open'||status==='cancel-pending'||status==='unknown',
    reservationMayBeReleased:false,settlementVerified:false,automaticRetryAllowed:false};
}

const observationKeys=['planSha256','clientOrderId','orderHash','revision','filledBaseAtomic','status'];
const progressSchema='realdex.injective-observed-progress.v1';
const safety={observationAuthenticated:false,signingEnabled:false,broadcastEnabled:false,executable:false};
// Accept bounded JSON data only, without invoking accessors, toJSON methods or prototypes.
function boundedJson(value,depth=0,budget={left:512}){
  need(depth<=8&&--budget.left>=0,'INJ_JSON_LIMIT');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string'){need(value.length<=8192,'INJ_JSON_LIMIT');return value;}
  if(typeof value==='number'){need(Number.isSafeInteger(value),'INJ_JSON_NUMBER');return value;}
  need(value&&typeof value==='object','INJ_JSON_DATA');
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
  need(array?proto===Array.prototype:proto===Object.prototype||proto===null,'INJ_JSON_PROTOTYPE');
  need(Object.getOwnPropertySymbols(value).length===0,'INJ_JSON_DATA');
  const names=Object.getOwnPropertyNames(value).filter(k=>!(array&&k==='length'));
  need(names.length<=512&&names.every(k=>k.length<=128),'INJ_JSON_LIMIT');
  need(!array||names.length===value.length&&names.every((k,i)=>k===String(i)),'INJ_JSON_ARRAY');
  const out=array?[]:{};
  for(const k of names){
    const d=Object.getOwnPropertyDescriptor(value,k);need(d.enumerable&&Object.hasOwn(d,'value')&&k!=='__proto__','INJ_JSON_DATA');
    Object.defineProperty(out,k,{value:boundedJson(d.value,depth+1,budget),enumerable:true,writable:true,configurable:true});
  }
  return out;
}
const flatHash=value=>sha(Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])));
function checkedPlan(value){
  const p=boundedJson(value);need(JSON.stringify(p).length<=65536,'INJ_JSON_LIMIT');
  need(p.schema===schema&&p.executable===false&&p.signingEnabled===false&&p.broadcastEnabled===false,'INJ_ORDER_PLAN');
  const {planSha256,...body}=p;
  need(typeof planSha256==='string'&&/^[a-f0-9]{64}$/.test(planSha256)&&sha(body)===planSha256,'INJ_PLAN_INTEGRITY');
  need(typeof p.clientOrderId==='string'&&/^rdx-[a-f0-9]{32}$/.test(p.clientOrderId)&&uint(p.baseQuantityAtomic)>0n,'INJ_ORDER_PLAN');
  return p;
}
function checkedObservation(plan,value){
  const o=boundedJson(value);fields(o,observationKeys);
  need(o.planSha256===plan.planSha256&&o.clientOrderId===plan.clientOrderId,'INJ_OBSERVATION_PLAN_MISMATCH');
  hash32(o.orderHash);need(o.orderHash!=='0x'+'00'.repeat(32),'INJ_EMPTY_ORDER_HASH');
  const revision=uint(o.revision,20);need(revision>0n&&revision<(1n<<64n),'INJ_OBSERVATION_REVISION');
  const progress=orderProgress(plan,o);
  return {observation:Object.fromEntries(observationKeys.map(k=>[k,o[k]])),progress};
}
function progressState(plan,observation){
  const {observation:o,progress}=checkedObservation(plan,observation);
  const body={schema:progressSchema,...o,...progress,observationSha256:flatHash(o),...safety};
  return {...body,stateSha256:flatHash(body)};
}
/** Local cumulative observations only. Revisions are application sequence numbers, not chain proofs.
 * Self-check hashes detect accidental alteration; anyone can recompute them. No settlement authority.
 */
export function reconcileInjectiveOrderObservation(plan,observation,previous=null){
  const p=checkedPlan(plan),next=progressState(p,observation);
  if(previous===null)return {state:next,duplicate:false};
  const prior=boundedJson(previous);
  fields(prior,Object.keys(next));
  const expected=progressState(p,Object.fromEntries(observationKeys.map(k=>[k,prior[k]])));
  need(Object.keys(expected).every(k=>prior[k]===expected[k]),'INJ_PREVIOUS_STATE_INVALID');
  need(next.orderHash===prior.orderHash,'INJ_ORDER_HASH_CHANGED');
  const rev=BigInt(next.revision),old=BigInt(prior.revision);
  need(rev>=old,'INJ_STALE_OBSERVATION');
  if(rev===old){need(next.observationSha256===prior.observationSha256,'INJ_REVISION_CONFLICT');return {state:expected,duplicate:true};}
  need(BigInt(next.filledBaseAtomic)>=BigInt(prior.filledBaseAtomic),'INJ_CUMULATIVE_FILL_REGRESSION');
  if(prior.reportedTerminal)need(next.status===prior.status&&next.filledBaseAtomic===prior.filledBaseAtomic,'INJ_TERMINAL_OBSERVATION_CONFLICT');
  return {state:next,duplicate:false};
}
