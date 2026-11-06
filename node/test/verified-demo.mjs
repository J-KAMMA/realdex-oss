#!/usr/bin/env node
/** Synthetic in-process demonstration. No network, EVM, wallet or deployment. */
import {NOW,ACCOUNT,F2,candidate,request,rpcFixture,TEST_POLICY} from './verified-fixtures.mjs';
import {openPinnedReadSession} from '../verified/rpc.mjs';
import {observeLocalPools,simulateObservedPool,compareObservedPools,planObservedGrossSplit} from '../verified/evm.mjs';
const fixture=rpcFixture(),session=await openPinnedReadSession({readers:fixture.readers,chainId:'eip155:84532',now:()=>NOW});
const observation=await observeLocalPools(session,[candidate(),candidate(F2)],request(),TEST_POLICY);
const simulations=await Promise.all(observation.pools.map(p=>simulateObservedPool(observation,p.routeId,{account:ACCOUNT,recipient:ACCOUNT})));
const result={scope:'SYNTHETIC_IN_PROCESS_RPC_MODEL_NOT_EVM_OR_MARKET_DATA',testOnlyFactoryPolicy:TEST_POLICY,
 observation,simulations,comparisonWithMissingCosts:compareObservedPools(observation,{simulations}),
 grossSplit:planObservedGrossSplit(observation),recordedReadCount:fixture.calls.length,
 walletAccess:false,signing:false,transactions:false};
console.log(JSON.stringify(result,(_key,value)=>typeof value==='bigint'?value.toString():value,2));
