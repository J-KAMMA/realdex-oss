/** Synthetic data, not market prices. No network or wallet access. */
import {injectiveMarket,hyperMarket,normalizeBook} from './market.mjs';
export const DEMO_MARKET='0x'+'ab'.repeat(32);
export function demoInputs(now=Date.now()) {
 return {market:{marketId:DEMO_MARKET,marketStatus:'active',ticker:'DEMO/USDx',baseDenom:'udemo',quoteDenom:'uusdx',baseTokenMeta:{symbol:'DEMO',decimals:'18'},quoteTokenMeta:{symbol:'USDx',decimals:'6'},takerFeeRate:'0.002',minPriceTickSize:'0.000000000001',minQuantityTickSize:'10000000000000000',minNotional:'1'},
 book:{buys:[{price:'0.00000000001',quantity:'500000000000000000'},{price:'0.000000000009',quantity:'2000000000000000000'}],sells:[{price:'0.000000000011',quantity:'1000000000000000000'},{price:'0.000000000012',quantity:'2000000000000000000'}],sequence:'9007199254740993',height:'100',timestamp:String(now)},
 hyperMeta:{tokens:[{index:0,name:'USDx',szDecimals:2,weiDecimals:6,tokenId:'0x'+'11'.repeat(16)},{index:1,name:'DEMO',szDecimals:2,weiDecimals:8,tokenId:'0x'+'22'.repeat(16)}],universe:[{index:1,name:'@1',tokens:[1,0]}]},
 hyperBook:{coin:'@1',time:now,levels:[[{px:'10',sz:'0.5',n:2},{px:'9',sz:'2',n:3}],[{px:'11',sz:'1',n:2},{px:'12',sz:'2',n:4}]]}};
}
export function demoSnapshot(provider='injective',now=Date.now()) {const x=demoInputs(now);return normalizeBook(provider==='injective'?injectiveMarket(x.market,'synthetic-demo',DEMO_MARKET):hyperMarket(x.hyperMeta,'synthetic-demo',1),provider==='injective'?x.book:x.hyperBook,{receivedAt:now});}
