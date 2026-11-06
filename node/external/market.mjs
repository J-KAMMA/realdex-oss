import {need,uint,small,decimal,rational,shift,pack,unpack,multiple,exactInt,label,timestamp,cmp,units} from './math.mjs';
export function networkId(value) {need(typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value),'SPOT_NETWORK');return value;}
const denom=s=>{label(s,200);need(/^[a-zA-Z0-9/:._-]+$/.test(s),'SPOT_DENOM');return s;};
export function injectiveMarket(raw,network,expectedId) {
 networkId(network);need(raw?.marketId===expectedId&&/^0x[0-9a-f]{64}$/.test(expectedId),'SPOT_MARKET_ID');
 need(raw.marketStatus==='active','SPOT_MARKET_INACTIVE');
 const baseDenom=denom(raw.baseDenom),quoteDenom=denom(raw.quoteDenom);need(baseDenom!==quoteDenom,'SPOT_IDENTICAL_ASSETS');
 const bd=small(raw.baseTokenMeta?.decimals),qd=small(raw.quoteTokenMeta?.decimals),fee=decimal(raw.takerFeeRate),tick=decimal(raw.minPriceTickSize),lot=exactInt(decimal(raw.minQuantityTickSize));
 need(fee.n<=fee.d&&tick.n>0n&&lot>0n&&lot.toString().length<=72,'SPOT_MARKET_LIMITS');
 return {schema:'realdex.external-spot-market.v1',provider:'injective',network,id:expectedId,ticker:label(raw.ticker),
  base:{id:`injective:${network}/bank:${baseDenom}`,decimals:bd,symbol:label(raw.baseTokenMeta.symbol||baseDenom)},
  quote:{id:`injective:${network}/bank:${quoteDenom}`,decimals:qd,symbol:label(raw.quoteTokenMeta.symbol||quoteDenom)},
  balanceLocation:`injective:${network}:exchange-subaccount`,priceTick:pack(tick),lotAtomic:lot.toString(),minNotionalQuote:pack(decimal(raw.minNotional??'0')),
  minNotionalKnown:raw.minNotional!==undefined,takerFeeRate:pack(fee),feeSource:'indexer-base-taker-rate; account-discounts-not-applied',decimalsSource:'indexer-unverified',orderRequirementsVerified:false};
}
function uniqueByIndex(items) {need(Array.isArray(items)&&items.length<=4096,'SPOT_META_SIZE');const m=new Map();for(const x of items){const i=small(x.index,1000000);need(!m.has(i),'SPOT_DUPLICATE_INDEX');m.set(i,x);}return m;}
export function hyperMarket(raw,network,pairIndex) {
 networkId(network);const index=small(pairIndex,1000000),tokens=uniqueByIndex(raw?.tokens),pairs=uniqueByIndex(raw?.universe),pair=pairs.get(index);
 need(pair&&Array.isArray(pair.tokens)&&pair.tokens.length===2,'SPOT_PAIR');const b=tokens.get(small(pair.tokens[0],1000000)),q=tokens.get(small(pair.tokens[1],1000000));need(b&&q&&b.index!==q.index,'SPOT_TOKEN_MAPPING');
 for(const t of [b,q])need(typeof t.tokenId==='string'&&/^0x[0-9a-f]{32}$/.test(t.tokenId),'SPOT_TOKEN_ID');need(b.tokenId!==q.tokenId,'SPOT_IDENTICAL_ASSETS');
 const bd=small(b.weiDecimals),qd=small(q.weiDecimals),sz=small(b.szDecimals,8);need(bd>=sz,'SPOT_SIZE_PRECISION');
 const coin=label(pair.name,80);need(coin===`@${index}` || index===0&&coin==='PURR/USDC','SPOT_SPOT_ONLY');
 return {schema:'realdex.external-spot-market.v1',provider:'hypercore',network,id:String(index),coin,ticker:`${label(b.name,40)}/${label(q.name,40)}`,
  base:{id:`hypercore:${network}/token:${b.tokenId}`,decimals:bd,symbol:label(b.name,40)},
  quote:{id:`hypercore:${network}/token:${q.tokenId}`,decimals:qd,symbol:label(q.name,40)},
  balanceLocation:`hypercore:${network}:spot`,priceTick:pack(shift(rational(1n,10n**BigInt(8-sz)),qd-bd)),lotAtomic:(10n**BigInt(bd-sz)).toString(),szDecimals:sz,
  minNotionalQuote:pack(rational(0n)),minNotionalKnown:false,takerFeeRate:null,feeSource:'not-fetched; user-tier-and-account-required',decimalsSource:'spotMeta-unverified',orderRequirementsVerified:false};
}
function assertHyperPrice(s,market) {need(typeof s==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s),'SPOT_HYPER_PRICE');const p=decimal(s);if(p.d===1n)return;const fraction=(s.split('.')[1]??'').replace(/0+$/,'');const significant=(s.split('.')[0]+fraction).replace(/^0+/,'').length;need(fraction.length<=8-market.szDecimals&&significant<=5,'SPOT_HYPER_PRICE_PRECISION');}
export function normalizeBook(market,raw,{receivedAt,maxAgeMs=30000,futureSkewMs=2000}={}) {
 need(market?.schema==='realdex.external-spot-market.v1','SPOT_MARKET');receivedAt=timestamp(receivedAt);small(maxAgeMs,300000);small(futureSkewMs,5000);
 const inj=market.provider==='injective';need(inj||market.provider==='hypercore','SPOT_PROVIDER');
 if(!inj)need(raw?.coin===market.coin&&Array.isArray(raw.levels)&&raw.levels.length===2,'SPOT_BOOK_ID');
 const at=timestamp(inj?raw.timestamp:raw.time);need(at>0&&at<=receivedAt+futureSkewMs&&receivedAt-at<=maxAgeMs,'SPOT_BOOK_STALE');
 const sides=inj?[raw.buys,raw.sells]:raw.levels,tick=unpack(market.priceTick),lot=uint(market.lotAtomic);
 const [bids,asks]=sides.map((side,index)=>{need(Array.isArray(side)&&side.length<=100,'SPOT_BOOK_DEPTH');let previous=null;return side.map(v=>{
  if(!inj){assertHyperPrice(v.px,market);need(small(v.n,100000000)>0,'SPOT_ORDER_COUNT');}
  const price=inj?decimal(v.price):shift(decimal(v.px),market.quote.decimals-market.base.decimals),qty=inj?exactInt(decimal(v.quantity)):units(v.sz,market.base.decimals);
  need(price.n>0n&&qty>0n&&qty.toString().length<=72&&qty%lot===0n,'SPOT_LEVEL');need(multiple(price,tick),'SPOT_PRICE_TICK');
  if(previous)need(index===0?cmp(previous,price)>0:cmp(previous,price)<0,'SPOT_BOOK_ORDER');previous=price;return {price:pack(price),baseAtomic:qty.toString()};
 });});
 if(bids.length&&asks.length)need(cmp(unpack(bids[0].price),unpack(asks[0].price))<0,'SPOT_CROSSED_BOOK');
 return {schema:'realdex.external-spot-snapshot.v1',market,bids,asks,serverTime:at,receivedAt,expiresAt:Math.min(at+maxAgeMs,receivedAt+maxAgeMs),
   sourceSequence:inj?uint(raw.sequence).toString():null,sourceHeight:inj?uint(raw.height??'0').toString():null,
   evidence:'unverified-provider-observation',networkIdentityVerified:false,executable:false};
}
