#!/usr/bin/env node
/** Offline example only. No RPC, wallet, signing, submission, or file mutation. */
import {prepareInjectiveLimitOrder,prepareInjectiveCancelOrder,orderProgress} from './external/injective-orders.mjs';
import {demoSnapshot} from './external/demo.mjs';
import {accountAddress} from '../wallet/codec/bech32.mjs';
if(process.argv.length!==2){console.error('Usage: node node/spot-order.mjs (synthetic offline example only)');process.exitCode=1;}
else{
 const sender=accountAddress('inj',Buffer.alloc(20,1));
 const plan=prepareInjectiveLimitOrder(demoSnapshot('injective'),{requestKey:'demo-order-1',sender,subaccountId:'0x'+'01'.repeat(20)+'00'.repeat(12),side:'buy',quantity:'1.25',limitPrice:'11'});
 const cancel=prepareInjectiveCancelOrder({sender,marketId:plan.marketId,subaccountId:plan.input.subaccountId,orderHash:'0x'+'cd'.repeat(32)});
 console.log(JSON.stringify({syntheticData:true,plan,partialFill:orderProgress(plan,{filledBaseAtomic:'500000000000000000',status:'cancel-pending'}),cancel},null,2));
}
