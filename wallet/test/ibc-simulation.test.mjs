import test from 'node:test';import assert from 'node:assert/strict';
import {validateIbcSimulations as check,simulateIbc} from '../bridge/ibc-simulation.mjs';
import {IbcRpc} from '../bridge/ibc-network.mjs';
import {cosmosFixtureNetwork} from './cosmos-online-fixtures.mjs';
const sample=(gas='124637',wanted='2000000')=>({gas_info:{gas_used:gas,gas_wanted:wanted},result:{data:'AQ==',log:'',events:[],msg_responses:[]}});
const network=count=>cosmosFixtureNetwork(Array.from({length:count},(_,i)=>({rpcUrl:`http://127.0.0.1:${7000+2*i}/`,restUrl:`http://127.0.0.1:${7001+2*i}/`})));
const encoded=Buffer.from('diagnostic-unsigned-placeholder').toString('base64');
test('Measured same-result variation selects the HIGHER gas and cannot claim execution',()=>{
 const v=check([sample('124682'),sample('124637')],'2000000');
 assert.equal(v.gasUsed,'124682');assert.equal(v.estimatesDiffer,true);assert.deepEqual(v.observedGasUsed,['124682','124637']);assert.equal(v.executionConfirmed,false);assert.equal(v.stateProofVerified,false);assert.ok(Object.isFrozen(v.observedGasUsed));
});
for(const count of [2,3,4])test('Every configured endpoint contributes to the maximum '+count,()=>{
 const v=check(Array.from({length:count},(_,i)=>sample(String(100+i))),'103');assert.equal(v.gasUsed,String(99+count));
});
test('Equal estimates retain original behavior and equality boundary passes',()=>{const v=check([sample('10'),sample('10')],'10');assert.equal(v.gasUsed,'10');assert.equal(v.estimatesDiffer,false);});
test('A high estimate cannot be hidden by a low or average estimate',()=>{assert.throws(()=>check([sample('1'),sample('1000001')],'1000000'),/GAS_LIMIT/);});
test('Estimate order never changes the selected gas',()=>{assert.equal(check([sample('11'),sample('13'),sample('12')],'13').gasUsed,check([sample('12'),sample('11'),sample('13')],'13').gasUsed);});
for(const gas of ['0','-1','01','1.0','1e2','18446744073709551616',null,1])test('Malformed or zero gas '+JSON.stringify(gas)+' is rejected',()=>assert.throws(()=>check([sample(),sample(gas)],'2000000')));
for(const wanted of ['0','-1','01','1.0','18446744073709551616',1,null,'124636'])test('Malformed or inadequate meter '+JSON.stringify(wanted)+' is rejected',()=>assert.throws(()=>check([sample(),sample('124637',wanted)],'2000000')));
for(const limit of ['0','-1','01','10000001',2000000,null])test('Invalid signed cap '+JSON.stringify(limit)+' fails',()=>assert.throws(()=>check([sample(),sample()],limit)));
for(const count of [0,1,5])test('No majority or single-endpoint fallback '+count,()=>assert.throws(()=>check(Array.from({length:count},()=>sample()),'2000000'),/ENDPOINT_COUNT/));
for(const field of ['data','log','events','msg_responses'])test('Semantic result disagreement is still rejected: '+field,()=>{
 const a=sample(),b=sample('124682');b.result[field]=Array.isArray(b.result[field])?[{value:'changed'}]:'changed';assert.throws(()=>check([a,b],'2000000'),/DISAGREEMENT/);
});
test('Gas meter disagreement is not treated as gas-use noise',()=>assert.throws(()=>check([sample(),sample('124682','1999999')],'2000000'),/DISAGREEMENT/));
for(const [name,change] of Object.entries({
 'missing gas':v=>delete v.gas_info.gas_used,'missing meter':v=>delete v.gas_info.gas_wanted,
 'error envelope':v=>v.error='denied','execution error':v=>v.code=1,'missing result':v=>delete v.result,
 'null result':v=>v.result=null,'array result':v=>v.result=[],
 'empty result':v=>v.result={},'events wrong shape':v=>v.result.events='x','extra result field':v=>v.result.unknown='x',
 'oversized events':v=>v.result.events=Array(129).fill(null),'oversized results':v=>v.result.msg_responses=Array(33).fill(null),
 'oversized result bytes':v=>v.result.events=Array(128).fill({value:'x'.repeat(2200)})
}))test('Incomplete/malformed response rejected: '+name,()=>{const v=sample();change(v);assert.throws(()=>check([sample(),v],'2000000'));});
test('Canonical result key order is immaterial but input remains unchanged',()=>{const a=sample(),b=sample('124682');b.result=Object.fromEntries(Object.entries(b.result).reverse());const before=JSON.stringify([a,b]);check([a,b],'2000000');assert.equal(JSON.stringify([a,b]),before);});
test('Transport sends exact bytes and height once to each endpoint, without a broadcast route',async()=>{
 const calls=[],rpc={rest:async(n,i,path,o)=>{calls.push({i,path,o});return sample(i===0?'124682':'124637');}};
 assert.equal((await simulateIbc(rpc,network(2),encoded,123,'2000000')).gasUsed,'124682');
 assert.deepEqual(calls,[0,1].map(i=>({i,path:'cosmos/tx/v1beta1/simulate',o:{height:123,body:{tx_bytes:encoded}}})));
});
for(const bad of ['missing','transport','HTTP','height'])test('Endpoint '+bad+' failure has no fallback or retry',async()=>{
 let calls=0;const rpc={rest:async(n,i)=>{calls++;if(i===1){if(bad==='missing')return undefined;throw Error('TEST_'+bad);}return sample();}};
 await assert.rejects(simulateIbc(rpc,network(2),encoded,123,'2000000'));assert.equal(calls,2);
});
for(const [height,cap,tx]of [[0,'2000000',encoded],[123,'0',encoded],[123,'10000001',encoded],[123,'2000000','bad base64']])test('Invalid request fails before any network '+JSON.stringify([height,cap,tx]),async()=>{
 let calls=0;await assert.rejects(simulateIbc({rest:async()=>{calls++;}},network(2),tx,height,cap));assert.equal(calls,0);
});
test('Actual Cosmos transport still rejects wrong height metadata and execution error',async()=>{
 for(const headers of [{'x-cosmos-block-height':'124'},{}]){
  let calls=0;const rpc=new IbcRpc({fetchImpl:async()=>{calls++;return new Response(JSON.stringify(sample()),{headers:{'content-type':'application/json',...headers}});}});
  await assert.rejects(simulateIbc(rpc,network(2),encoded,123,'2000000'),/HEIGHT_MISMATCH/);assert.equal(calls,2);
 }
});
test('A uint64-unlimited simulation meter NEVER expands the owner signed gas cap',()=>{
 const max='18446744073709551615';const v=check([sample('124682',max),sample('124637',max)],'124682');
 assert.equal(v.gasWanted,max);assert.equal(v.gasLimit,'124682');
 assert.throws(()=>check([sample('124683',max),sample('124637',max)],'124682'),/GAS_LIMIT/);
});
