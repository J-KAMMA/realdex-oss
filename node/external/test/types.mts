import {observeSpot,createObservationSession} from '../observer.mjs';
import {quoteSpot} from '../quote.mjs';
async function check(){
 const data=await observeSpot({provider:'injective',endpoint:'http://127.0.0.1:9000',network:'test',marketId:'0x123'});
 const q=quoteSpot(data,{side:'sell-base',inputAtomic:'100'});const disabled:false=q.executable;
 // @ts-expect-error Atomic quantities must never be JavaScript numbers.
 quoteSpot(data,{side:'sell-base',inputAtomic:9007199254740993});
 // @ts-expect-error No derivative book provider.
 observeSpot({provider:'perps',endpoint:'https://example.org'});
 // @ts-expect-error This observation session has no signing or sending operation.
 createObservationSession().sendTransaction();
 return disabled;
}
void check; // Type-only example: does not contact a network.
