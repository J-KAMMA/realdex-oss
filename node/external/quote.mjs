import {need,uint,small,unpack,decimal,shift,rational,mul,ceil,floor,cmp} from './math.mjs';
/** Walk only the observed book. Never constructs an order or guarantees a fill.
 * Quote-asset fees round against the caller at each level; this is an indicative
 * conservative atom model, not an exchange's matching/rounding specification. */
export function quoteSpot(snapshot,request,{now=Date.now()}={}) {
 need(snapshot?.schema==='realdex.external-spot-snapshot.v1'&&snapshot.executable===false,'SPOT_SNAPSHOT');
 need(Number.isSafeInteger(now)&&now>=snapshot.receivedAt&&now<=snapshot.expiresAt,'SPOT_QUOTE_EXPIRED');
 need(request&&['sell-base','buy-base'].includes(request.side),'SPOT_SIDE');
 const input=uint(request.inputAtomic),m=snapshot.market,lot=uint(m.lotAtomic);need(input>0n&&lot>0n,'SPOT_INPUT');
 const sell=request.side==='sell-base',levels=sell?snapshot.bids:snapshot.asks;
 need(Array.isArray(levels)&&levels.length<=100,'SPOT_BOOK_DEPTH');
 const known=m.takerFeeRate!==null,rate=known?unpack(m.takerFeeRate):rational(0n);need(rate.n<=rate.d,'SPOT_FEE');
 const limit=request.limitPrice===undefined||request.limitPrice===''?null:shift(decimal(request.limitPrice),m.quote.decimals-m.base.decimals);if(limit)need(limit.n>0n,'SPOT_LIMIT');
 const slippage=small(request.slippageBps??0,5000),fills=[];
 let remaining=input,base=0n,notional=0n,fees=0n,stop='depth-exhausted';
 for(const level of levels){const price=unpack(level.price),available=uint(level.baseAtomic);need(price.n>0n&&available>0n&&available%lot===0n,'SPOT_LEVEL');
  if(limit&&(sell?cmp(price,limit)<0:cmp(price,limit)>0)){stop='limit-reached';break;}
  const gross=n=>sell?floor(mul(price,rational(n))):ceil(mul(price,rational(n)));
  const fee=n=>ceil(mul(rational(gross(n)),rate));
  let take;
  if(sell)take=(remaining<available?remaining:available)/lot*lot;
  else{let lo=0n,hi=available/lot;while(lo<hi){const mid=(lo+hi+1n)/2n,qty=mid*lot;if(gross(qty)+fee(qty)<=remaining)lo=mid;else hi=mid-1n;}take=lo*lot;}
  if(take===0n){stop='residual-input';break;}
  const g=gross(take),f=fee(take);need(g>=f,'SPOT_FEE_EXCEEDS_OUTPUT');
  base+=take;notional+=g;fees+=f;remaining-=sell?take:g+f;
  fills.push({baseAtomic:String(take),quoteNotionalAtomic:String(g),quoteFeeAtomic:known?String(f):null,price:level.price});
  if(remaining===0n){stop='filled';break;}
  if(take<available){stop='residual-input';break;}
 }
 const minimum=unpack(m.minNotionalQuote),minimumMet=cmp(rational(notional),minimum)>=0;
 if(base===0n)stop=stop==='limit-reached'?stop:'no-fill';else if(!minimumMet)stop='below-minimum-notional';
 const output=sell?notional-fees:base,estimated=known&&minimumMet&&base>0n?String(output):null;
 return {schema:'realdex.external-spot-estimate.v1',provider:m.provider,network:m.network,marketId:m.id,side:request.side,
  inputAsset:sell?m.base:m.quote,outputAsset:sell?m.quote:m.base,balanceLocation:m.balanceLocation,inputAtomic:String(input),consumedInputAtomic:String(input-remaining),remainingInputAtomic:String(remaining),
  baseFilledAtomic:String(base),quoteNotionalAtomic:String(notional),tradingFeeQuoteAtomic:known?String(fees):null,
  outputBeforeTradingFeeAtomic:String(sell?notional:base),estimatedOutputAfterTradingFeeAtomic:estimated,
  hypotheticalSlippageFloorAtomic:estimated===null?null:String(output*BigInt(10000-slippage)/10000n),
  fillStatus:stop,fullInputConsumed:remaining===0n&&base>0n&&minimumMet,tradingFeesKnown:known,minimumOrderKnown:m.minNotionalKnown,
  actualTradingFeeVerified:false,feeCoverage:'indexer-base-rate-only; no atomic-order-multiplier or account-tier verification',additionalCostsKnown:false,gasAndWithdrawalCostAtomic:null,receivedAt:snapshot.receivedAt,expiresAt:snapshot.expiresAt,requestLimitPrice:request.limitPrice??null,
  fills,executable:false,fillGuaranteed:false,globallyOptimal:false,deliveredToWallet:false,
  warnings:['OBSERVED_BOOK_NOT_RESERVED','NETWORK_AND_WITHDRAWAL_COSTS_UNKNOWN','BALANCE_LOCATION_NOT_DESTINATION_WALLET',...(!known?['TRADING_FEE_UNKNOWN']:[]),...(!m.minNotionalKnown?['MINIMUM_ORDER_UNKNOWN']:[])]};
}
/** Comparison is deliberately narrow: identical asset IDs and settlement location,
 * full input use, identical limits, known trading fees, unexpired snapshots. */
export function compareIndicativeQuotes(quotes,{now=Date.now()}={}) {
 need(Array.isArray(quotes)&&quotes.length>0&&quotes.length<=16,'SPOT_COMPARE_COUNT');const a=quotes[0];
 const key=q=>JSON.stringify([q.inputAsset.id,q.inputAsset.decimals,q.outputAsset.id,q.outputAsset.decimals,q.balanceLocation,q.inputAtomic,q.side,q.requestLimitPrice]);
 const rejected=[];for(const [index,q]of quotes.entries()){
  need(q?.schema==='realdex.external-spot-estimate.v1'&&q.executable===false,'SPOT_ESTIMATE');
  const reasons=[];if(key(q)!==key(a))reasons.push('DIFFERENT_ASSETS_OR_LOCATION_OR_REQUEST');
  if(now<q.receivedAt||now>q.expiresAt)reasons.push('EXPIRED');if(!q.tradingFeesKnown)reasons.push('UNKNOWN_TRADING_FEE');if(!q.minimumOrderKnown)reasons.push('UNKNOWN_MINIMUM_ORDER');if(!q.fullInputConsumed)reasons.push('PARTIAL_INPUT');
  if(q.estimatedOutputAfterTradingFeeAtomic===null)reasons.push('NO_ELIGIBLE_OUTPUT');else uint(q.estimatedOutputAfterTradingFeeAtomic);
  if(reasons.length)rejected.push({index,reasons});
 }
 const rejectedIndexes=new Set(rejected.map(x=>x.index));const ranking=quotes.map((q,index)=>({index,output:q.estimatedOutputAfterTradingFeeAtomic})).filter(x=>!rejectedIndexes.has(x.index)).sort((x,y)=>BigInt(x.output)===BigInt(y.output)?x.index-y.index:BigInt(x.output)>BigInt(y.output)?-1:1);
 return {schema:'realdex.external-indicative-comparison.v1',basis:'trading-fee-only; excludes funding,gas,withdrawal,bridge',ranking,rejected,netBest:null,executable:false,globallyOptimal:false};
}
