import {transport} from './transport.mjs';
import {decodeMarket,decodeBook,unary,marketRequest,bookRequest} from './protobuf.mjs';
import {injectiveMarket,hyperMarket,normalizeBook,networkId} from './market.mjs';
import {need,same} from './math.mjs';
/** No keys, addresses, balances, trading API or signing objects are accepted here. */
export async function observeSpot(selection,{access={},signal,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=8000,maxAgeMs=30000}={}) {
 need(selection&&['injective','hypercore'].includes(selection.provider),'SPOT_PROVIDER');
 const allowed=selection.provider==='injective'?['provider','network','endpoint','marketId']:['provider','network','endpoint','pairIndex'];
 need(Object.keys(selection).every(k=>allowed.includes(k))&&allowed.every(k=>Object.hasOwn(selection,k)),'SPOT_SELECTION');
 selection=Object.freeze({...selection});networkId(selection.network);
 const request=transport(selection.endpoint,{access,signal,fetchImpl,timeoutMs});
 let market,book,again;
 if(selection.provider==='injective'){
  need(/^0x[0-9a-f]{64}$/.test(selection.marketId),'SPOT_MARKET_ID');
  const getMarket=async()=>{const r=await request('Market',marketRequest(selection.marketId));return injectiveMarket(decodeMarket(unary(r.bytes,r.status)),selection.network,selection.marketId);};
  market=await getMarket();const r=await request('OrderbookV2',bookRequest(selection.marketId));book=decodeBook(unary(r.bytes,r.status));again=await getMarket();
 }else{
  market=hyperMarket(await request('spotMeta'),selection.network,selection.pairIndex);
  book=await request('l2Book',market.coin);again=hyperMarket(await request('spotMeta'),selection.network,selection.pairIndex);
 }
 need(same(market,again),'SPOT_MARKET_CHANGED');signal?.throwIfAborted();return normalizeBook(market,book,{receivedAt:now(),maxAgeMs});
}
/** UI use: a late result from a cancelled/edited request can never replace the new one. */
export function createObservationSession() {
 let generation=0,controller=null;
 const cancel=()=>{generation++;controller?.abort();controller=null;};
 return {cancel,async run(selection,options={}){cancel();const mine=generation;controller=new AbortController();const joined=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
   try{const result=await observeSpot(selection,{...options,signal:joined});need(mine===generation&&!joined.aborted,'SPOT_STALE_REQUEST');return result;}finally{if(mine===generation)controller=null;}
 }};
}
