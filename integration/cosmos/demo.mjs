#!/usr/bin/env node
/** Destructive only to its own disposable test home; no public network or user keys. */
import {startSimd,simdWalletFixture} from './fixture.mjs';
let chain,f;
try{
 chain=await startSimd();f=await simdWalletFixture(chain);
 const before={from:String(await chain.balance(f.account.address)),to:String(await chain.balance(chain.to)),sequence:(await chain.account(f.account.address)).sequence};
 const request=await f.prepare(),record=await f.approve(request,true),result=await f.settled(record),again=await f.prepare();
 const after={from:String(await chain.balance(f.account.address)),to:String(await chain.balance(chain.to)),sequence:(await chain.account(f.account.address)).sequence};
 console.log(JSON.stringify({scope:'Real pinned development simd, one validator, two forwarding endpoint pairs',realNativeExecution:true,publicNetwork:false,realAssets:false,amountAtomic:'1250000',feeAtomic:'500',denom:'stake',before,after,submitted:f.state.sent,duplicateReturnedExisting:again.alreadyRecorded,txHash:result.signed.requestId,observation:result.report,productionReady:false},null,2));
}catch(e){console.error(e.message);process.exitCode=1;}finally{await f?.close();await chain?.close();}
