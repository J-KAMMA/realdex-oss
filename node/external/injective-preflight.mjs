/** Injective testnet query/simulation pipeline. Never a signer or broadcast capability. */
import {createHash,ECDH} from 'node:crypto';
import {accountAddress} from '../../wallet/codec/bech32.mjs';
import {fieldBytes as bytes,fieldText as text,fieldUint as u64,anyMessage} from '../../wallet/codec/protobuf.mjs';
import {keccak256} from '../verified/keccak.mjs';
import {guardedEndpoint,boundedSignal} from '../extended/guard.mjs';
import {readBytes} from '../extended/http.mjs';
import {parseExactJson} from '../extended/json.mjs';
import {prepareInjectiveLimitOrder} from './injective-orders.mjs';
import {observeSpot} from './observer.mjs';
import {need,uint,small,decimal,unpack,cmp,mul,rational,ceil,floor,pack,shift} from './math.mjs';
const sha=x=>createHash('sha256').update(typeof x==='string'||x instanceof Uint8Array?x:JSON.stringify(x)).digest('hex');
const keys=(o,ks)=>need(o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===ks.length&&ks.every(k=>Object.hasOwn(o,k)),'INJ_PREFLIGHT_FIELDS');
const counter=s=>{const n=uint(s,20);need(n<1n<<64n,'INJ_COUNTER_RANGE');return n;};
const fixed=s=>{need(typeof s==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(s)&&s.length<=90,'INJ_CHAIN_DECIMAL');return decimal(s);};
const join=(...parts)=>Buffer.concat(parts);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
/** Bounded plain data. Does not invoke getters/toJSON; not a sandbox for Proxy traps. */
function copy(x,depth=0,budget={n:5000}){
 need(depth<=12&&--budget.n>=0,'INJ_INPUT_LIMIT');
 if(x===null||typeof x==='boolean')return x;
 if(typeof x==='string'){need(x.length<=16384,'INJ_INPUT_LIMIT');return x;}
 if(typeof x==='number'){need(Number.isSafeInteger(x),'INJ_INPUT_NUMBER');return x;}
 need(x&&typeof x==='object','INJ_INPUT_DATA');const a=Array.isArray(x),p=Object.getPrototypeOf(x);
 need(a?p===Array.prototype:p===Object.prototype||p===null,'INJ_INPUT_DATA');
 const ns=Object.getOwnPropertyNames(x).filter(k=>!a||k!=='length');
 need(!Object.getOwnPropertySymbols(x).length&&ns.length<=300&&(!a||ns.length===x.length&&ns.every((k,i)=>k===String(i))),'INJ_INPUT_LIMIT');
 const o=a?[]:{};for(const k of ns){const d=Object.getOwnPropertyDescriptor(x,k);need(d.enumerable&&Object.hasOwn(d,'value')&&k.length<=100&&!['__proto__','constructor','prototype'].includes(k),'INJ_INPUT_DATA');o[k]=copy(d.value,depth+1,budget);}return o;
}
function publicIdentity(hex){
 need(typeof hex==='string'&&/^(02|03)[a-f0-9]{64}$/.test(hex),'INJ_PUBLIC_KEY');
 let pub;try{pub=ECDH.convertKey(Buffer.from(hex,'hex'),'secp256k1',undefined,undefined,'uncompressed');}catch{throw Error('INJ_PUBLIC_KEY');}
 return accountAddress('inj',Buffer.from(keccak256(pub.subarray(1)).slice(-40),'hex'));
}
function policyOf(p){
 keys(p,['gasLimit','gasPriceAtomic','maxGasFeeAtomic','maxTradingFeeBps','gasMarginBps','timeoutBlocks','maxAgeMs']);
 const gas=counter(p.gasLimit),price=fixed(p.gasPriceAtomic),maxFee=uint(p.maxGasFeeAtomic);
 need(gas>0n&&gas<=10000000n&&price.n>0n&&cmp(price,rational(10n**18n))<=0,'INJ_GAS_POLICY');
 const fee=ceil(mul(price,rational(gas)));need(fee<=maxFee,'INJ_GAS_FEE_CAP');
 const bps=small(p.maxTradingFeeBps,10000),margin=small(p.gasMarginBps,30000),blocks=small(p.timeoutBlocks,100),age=small(p.maxAgeMs,30000);
 need(margin>=10000&&blocks>0&&age>=1000,'INJ_GAS_POLICY');return {gas,fee,bps,margin,blocks,age};
}
function blockOf(raw,chainId,now,maxAge){
 const a=raw.block?.header,b=raw.sdk_block?.header;
 need(a||b,'INJ_BLOCK_RESPONSE');if(a&&b)need(a.chain_id===b.chain_id&&a.height===b.height&&a.time===b.time,'INJ_BLOCK_AMBIGUOUS');
 const h=a??b;need(h.chain_id===chainId,'INJ_CHAIN_MISMATCH');const height=counter(h.height);need(height>0n,'INJ_BLOCK_HEIGHT');
 const value=raw.block_id?.hash;let hash;
 if(typeof value==='string'&&/^[a-fA-F0-9]{64}$/.test(value))hash=value.toLowerCase();
 else {need(typeof value==='string'&&Buffer.from(value,'base64').length===32&&Buffer.from(value,'base64').toString('base64')===value,'INJ_BLOCK_HASH');hash=Buffer.from(value,'base64').toString('hex');}
 need(hash!=='0'.repeat(64),'INJ_BLOCK_HASH');
 need(typeof h.time==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(h.time),'INJ_BLOCK_TIME');
 const at=Date.parse(h.time);need(Number.isFinite(at)&&at<=now+2000&&now-at<=maxAge,'INJ_BLOCK_STALE');
 return {height:String(height),hash,time:h.time,timeMs:at,chainId};
}
async function abortable(p,signal){signal.throwIfAborted();let f;const stop=new Promise((_,reject)=>{f=()=>reject(Error('INJ_PREFLIGHT_ABORTED'));signal.addEventListener('abort',f,{once:true});});try{return await Promise.race([p,stop]);}finally{signal.removeEventListener('abort',f);}}
function rest(endpoint,{access,signal,fetchImpl,receipts}){
 const base=guardedEndpoint(endpoint,access);need(base.pathname==='/'&&!base.search,'INJ_REST_ROOT');let active=0;
 // Only internal fixed paths reach this closure; it is never exported as a generic RPC.
 return async(path,height,simulation)=>{
  need(active<2,'INJ_PREFLIGHT_CONCURRENCY');active++;try{
   const url=new URL(path,base),method=simulation?'POST':'GET';
   need(url.origin===base.origin&&(!simulation||path==='/cosmos/tx/v1beta1/simulate'),'INJ_READ_ONLY');
   const body=simulation?JSON.stringify({tx_bytes:simulation}):undefined;
   const r=await abortable(Promise.resolve().then(()=>fetchImpl(url.href,{method,body,headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{}),...(height?{'x-cosmos-block-height':height}:{})},signal,credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'})),signal);
   need(!r.redirected,'INJ_REDIRECT');const raw=await readBytes(r,{signal,maxBytes:524288});
   // grpc-gateway may prefix outgoing metadata; never accept missing or conflicting heights.
   if(height){const hs=['x-cosmos-block-height','grpc-metadata-x-cosmos-block-height'].map(k=>r.headers.get(k)).filter(v=>v!==null);need(hs.length>0&&hs.every(v=>v===height),'INJ_RESPONSE_HEIGHT');}
   let decoded;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{throw Error('INJ_RESPONSE_UTF8');}
   const data=parseExactJson(decoded,{maxChars:524288,maxNodes:10000,maxDepth:24});
   need(data&&typeof data==='object'&&!Array.isArray(data)&&!Object.hasOwn(data,'error')&&!Object.hasOwn(data,'code'),'INJ_RESPONSE_ERROR');
   receipts.push({method,path,height:height??null,responseSha256:sha(raw),...(body?{requestSha256:sha(body)}:{})});return data;
  }finally{active--;}
 };
}
function unsigned(plan,account,publicKeyHex,fee,gas,timeoutHeight){
 const body=join(bytes(1,Buffer.from(plan.message.anyBase64,'base64')),u64(3,timeoutHeight));
 const pub=anyMessage('/injective.crypto.v1beta1.ethsecp256k1.PubKey',bytes(1,Buffer.from(publicKeyHex,'hex')));
 const signer=join(bytes(1,pub),bytes(2,bytes(1,u64(1,1n))),u64(3,counter(account.sequence)));
 const coin=join(text(1,'inj'),text(2,String(fee))),auth=join(bytes(1,signer),bytes(2,join(bytes(1,coin),u64(2,gas))));
 const signDoc=join(bytes(1,body),bytes(2,auth),text(3,plan.network),u64(4,counter(account.accountNumber)));
 // Exactly one empty signature is used by the official REST SDK for unsigned simulation.
 const sim=join(bytes(1,body),bytes(2,auth),bytes(3,Buffer.alloc(0)));
 return {bodyBytesBase64:body.toString('base64'),authInfoBytesBase64:auth.toString('base64'),signDocBase64:signDoc.toString('base64'),simulationTxBase64:sim.toString('base64'),timeoutHeight:String(timeoutHeight),signMode:'SIGN_MODE_DIRECT',fee:{denom:'inj',amount:String(fee),gasLimit:String(gas)},signatures:[]};
}
/** Fixed testnet preflight. One selected endpoint is observed, not cryptographically authenticated. */
export async function preflightInjectiveLimitOrder(request,{access={},signal,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=30000}={}){
 request=copy(request);keys(request,['snapshot','input','chainId','endpoint','publicKeyHex','policy']);
 need(request.chainId==='injective-888'&&request.snapshot?.market?.network===request.chainId,'INJ_TESTNET_ONLY');
 need(typeof fetchImpl==='function'&&typeof now==='function','INJ_PREFLIGHT_OPTIONS');
 const policy=policyOf(request.policy),joined=boundedSignal(signal,timeoutMs);let last=0;
 const clock=()=>{joined.throwIfAborted();const n=now();need(Number.isSafeInteger(n)&&n>0&&n>=last,'INJ_CLOCK');last=n;return n;};
 const started=clock(),plan=prepareInjectiveLimitOrder(request.snapshot,request.input,{now:started});
 need(publicIdentity(request.publicKeyHex)===plan.input.sender,'INJ_PUBLIC_KEY_OWNER');
 const receipts=[],get=rest(request.endpoint,{access,signal:joined,fetchImpl,receipts});
 try{
  const anchor=blockOf(await get('/cosmos/base/tendermint/v1beta1/blocks/latest'),request.chainId,clock(),policy.age),height=anchor.height;
  const [ar,mr]=await Promise.all([get('/cosmos/auth/v1beta1/accounts/'+plan.input.sender,height),get('/injective/exchange/v2/spot/markets/'+plan.marketId,height)]);
  need(ar.account?.['@type']==='/injective.types.v1beta1.EthAccount','INJ_ACCOUNT_TYPE');const a=ar.account.base_account;
  need(a?.address===plan.input.sender,'INJ_ACCOUNT_OWNER');counter(a.account_number);counter(a.sequence);
  if(a.pub_key!==null){need(a.pub_key?.['@type']==='/injective.crypto.v1beta1.ethsecp256k1.PubKey'&&a.pub_key.key===Buffer.from(request.publicKeyHex,'hex').toString('base64'),'INJ_ACCOUNT_KEY');}
  const account={address:a.address,accountNumber:a.account_number,sequence:a.sequence,publicKeyHex:request.publicKeyHex};
  const m=mr.market,s=request.snapshot.market;need(m?.market_id===plan.marketId&&m.status==='Active','INJ_CHAIN_MARKET');
  const prefix='injective:'+request.chainId+'/bank:',bd=plan.baseAsset.id.slice(prefix.length),qd=plan.quoteAsset.id.slice(prefix.length);
  need(m.base_denom===bd&&m.quote_denom===qd&&small(m.base_decimals)===small(plan.baseAsset.decimals)&&small(m.quote_decimals)===small(plan.quoteAsset.decimals),'INJ_CHAIN_ASSET_MISMATCH');
  // Explicit v2 query values are human units; the existing order/indexer representation uses atoms.
  need(cmp(shift(fixed(m.min_price_tick_size),small(m.quote_decimals)-small(m.base_decimals)),unpack(s.priceTick))===0&&cmp(shift(fixed(m.min_quantity_tick_size),small(m.base_decimals)),rational(uint(s.lotAtomic)))===0&&cmp(shift(fixed(m.min_notional),small(m.quote_decimals)),unpack(s.minNotionalQuote))===0,'INJ_CHAIN_REQUIREMENTS_CHANGED');
  const taker=fixed(m.taker_fee_rate);need(cmp(taker,unpack(s.takerFeeRate))===0,'INJ_CHAIN_FEE_CHANGED');
  const maker=typeof m.maker_fee_rate==='string'&&m.maker_fee_rate.startsWith('-')?(fixed(m.maker_fee_rate.slice(1)),rational(0n)):fixed(m.maker_fee_rate);
  const cap=rational(BigInt(policy.bps),10000n);need(cmp(taker,cap)<=0&&cmp(maker,cap)<=0,'INJ_TRADING_FEE_CAP');
  const notional=unpack(plan.quoteNotionalAtLimit),tradeFee=ceil(mul(notional,cap));
  const reserve=plan.input.side==='buy'?ceil(notional)+tradeFee:uint(plan.baseQuantityAtomic),denom=plan.input.side==='buy'?qd:bd;
  const defaultSub=plan.input.subaccountId.slice(-24)==='0'.repeat(24);
  const bankPath=d=>'/cosmos/bank/v1beta1/spendable_balances/'+plan.input.sender+'/by_denom?denom='+encodeURIComponent(d);
  const spendPath=defaultSub?bankPath(denom):'/injective/exchange/v1beta1/exchange/subaccountDeposit?subaccount_id='+plan.input.subaccountId+'&denom='+encodeURIComponent(denom);
  const gasRaw=await get(bankPath('inj'),height);
  const coin=(r,d)=>{need(r.balance?.denom===d,'INJ_BALANCE_DENOM');return uint(r.balance.amount);};
  const gasAvailable=coin(gasRaw,'inj');let available;
  if(defaultSub&&denom==='inj')available=gasAvailable;
  else {const raw=await get(spendPath,height);if(defaultSub)available=coin(raw,denom);else {const v=raw.deposits;need(v,'INJ_DEPOSIT_MISSING');const av=fixed(v.available_balance),total=fixed(v.total_balance);need(cmp(av,total)<=0,'INJ_DEPOSIT_INCONSISTENT');available=floor(av);}}
  const combined=defaultSub&&denom==='inj';need(gasAvailable>=policy.fee,'INJ_INSUFFICIENT_GAS');need(available>=reserve+(combined?policy.fee:0n),'INJ_INSUFFICIENT_SPENDABLE');
  const timeoutHeight=counter(height)+BigInt(policy.blocks);need(timeoutHeight<1n<<64n,'INJ_COUNTER_RANGE');
  const tx=unsigned(plan,account,request.publicKeyHex,policy.fee,policy.gas,timeoutHeight);
  const sim=await get('/cosmos/tx/v1beta1/simulate',height,tx.simulationTxBase64);
  const used=counter(sim.gas_info?.gas_used),wanted=counter(sim.gas_info?.gas_wanted);
  // Injective simulates with its chain meter; gas_wanted is NOT an echo of our signed gas limit.
  need(used>0n&&wanted>=used&&used<=policy.gas&&sim.result&&typeof sim.result==='object'&&!Array.isArray(sim.result),'INJ_SIMULATION_RESPONSE');
  need(used*BigInt(policy.margin)<=policy.gas*10000n,'INJ_SIMULATION_GAS_MARGIN');
  const end=blockOf(await get('/cosmos/base/tendermint/v1beta1/blocks/'+height),request.chainId,clock(),policy.age);
  need(end.height===height&&end.hash===anchor.hash&&end.time===anchor.time,'INJ_BLOCK_CHANGED');
  const finished=clock(),expiresAt=Math.min(request.snapshot.expiresAt,anchor.timeMs+policy.age,started+policy.age);
  need(finished<=expiresAt,'INJ_PREFLIGHT_EXPIRED');
  const review={schema:'realdex.injective-preflight.v1',chainId:request.chainId,queryApiVersion:'injective.exchange.v2',endpoint:new URL(request.endpoint).origin,plan,anchor,account,
   spend:{location:defaultSub?'bank-spendable-conservative':'exchange-subaccount',denom,availableAtomic:String(available),requiredAtomic:String(reserve),gasSharesBalance:combined},
   costs:{gasAvailableAtomic:String(gasAvailable),gasFeeAtomic:String(policy.fee),tradingFeeQuoteCapAtomic:String(tradeFee),tradingFeeRateCap:pack(cap),gasPriceSource:'caller-selected-not-a-chain-quote',tradingFeeCapEnforcedOnChain:false},
   policy:request.policy,transaction:tx,simulation:{gasUsed:String(used),gasWanted:String(wanted),executedBy:'selected-endpoint-simulation',authenticated:false},
   observedAt:finished,expiresAt,receipts,readyForOwnerReview:true,ownerApproved:false,chainStateAuthenticated:false,signingEnabled:false,broadcastEnabled:false,executable:false,settlementVerified:false,
   blockers:['CHAIN_STATE_AUTHENTICATION_REQUIRED','OWNER_APPROVAL_AND_SIGNER_REQUIRED','LIVE_VENUE_LIFECYCLE_UNVERIFIED'],
   warnings:['SIMULATION_IS_NOT_EXECUTION','SNAPSHOT_AND_FEES_CAN_CHANGE','GTC_ORDER_OUTLIVES_TRANSACTION_TIMEOUT','DEFAULT_SUBACCOUNT_EXCHANGE_FUNDS_NOT_COUNTED']};
  return freeze({...review,reviewSha256:sha(review)});
 }catch(e){throw Error(joined.aborted?'INJ_PREFLIGHT_ABORTED':e instanceof Error&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:'INJ_PREFLIGHT_FAILED');}
}
/** Real integration entry point: existing indexer reader -> plan -> chain preflight -> simulation. */
export async function observeAndPreflightInjectiveOrder(request,options={}){
 request=copy(request);keys(request,['selection','input','endpoint','publicKeyHex','policy']);
 need(request.selection?.provider==='injective'&&request.selection.network==='injective-888','INJ_TESTNET_ONLY');
 // Validate both destinations before disclosing any public account/order information.
 guardedEndpoint(request.endpoint,options.access);guardedEndpoint(request.selection.endpoint,options.access);policyOf(request.policy);
 need(publicIdentity(request.publicKeyHex)===request.input?.sender,'INJ_PUBLIC_KEY_OWNER');
 const signal=boundedSignal(options.signal,options.timeoutMs??30000);
 const snapshot=await observeSpot(request.selection,{...options,signal,maxAgeMs:small(request.policy.maxAgeMs,30000)});
 return preflightInjectiveLimitOrder({snapshot,input:request.input,chainId:request.selection.network,endpoint:request.endpoint,publicKeyHex:request.publicKeyHex,policy:request.policy},{...options,signal});
}
