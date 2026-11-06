import test from 'node:test';import assert from 'node:assert/strict';
import {openPinnedReadSession} from '../verified/rpc.mjs';
import {observeLocalPools,recheckObservation,assertCurrentObservation,simulateObservedPool,compareObservedPools,planObservedGrossSplit,observationJson,uintWord,parseDiscoveryRequest,FACTORY_RUNTIME_HASH} from '../verified/evm.mjs';
import {rpcFixture,NOW,F,F2,A,B,P,P2,ACCOUNT,OTHER_H,TEST_POLICY,request,candidate,isCall} from './verified-fixtures.mjs';
async function fixture(options={}){const f=rpcFixture(options);let now=NOW;const session=await openPinnedReadSession({readers:f.readers,chainId:'eip155:84532',now:()=>now});return {...f,session,setTime:n=>now=n,observe:(r=request(),c=[candidate(),candidate(F2)])=>observeLocalPools(session,c,r,TEST_POLICY)};}
test('default bundled trust root rejects a synthetic fixture runtime',async()=>{const f=await fixture(),o=await observeLocalPools(f.session,[candidate()],request());assert.equal(o.pools.length,0);assert.equal(o.rejected[0].code,'FACTORY_CODE_MISMATCH');assert.equal(o.factoryRuntimeHash,FACTORY_RUNTIME_HASH);});
test('test-local trust root is explicit in output and never supplied by candidate',async()=>{const f=await fixture(),o=await f.observe();assert.equal(o.factoryRuntimeHash,TEST_POLICY.factoryRuntimeHash);assert.equal(o.pools.length,2);assert.equal(o.executable,false);assert.equal(o.tokenTransferBehaviorVerified,false);assert.equal(o.rejected.filter(x=>x.code==='POOL_NOT_FOUND').length,2);assert.equal(o.pools[0].pool,P);assert.ok(o.pools[1].expectedOut>o.pools[0].expectedOut);});
test('reverse pair independently quotes from opposite reserve orientation',async()=>{const f=await fixture(),o=await f.observe(request({tokenIn:B,tokenOut:A}));assert.equal(o.pools.length,2);assert.equal(o.pools[1].reserveIn,1100000n);assert.equal(o.pools[1].reserveOut,1000000n);});
test('untrusted candidate fields cannot set pool, quote, fee or trust hash',async()=>{const f=await fixture(),c={...candidate(),pool:P2,expectedOut:'99999999999',runtimeHash:TEST_POLICY.factoryRuntimeHash,rpcUrl:'https://evil.invalid',spender:ACCOUNT},o=await f.observe(request(),[c]);assert.equal(o.pools[0].pool,P);assert.notEqual(o.pools[0].expectedOut,99999999999n);assert.ok(f.calls.every(x=>x.params[0]?.to!=='https://evil.invalid'));});
test('observation and nested context are frozen and cannot be forged by JSON',async()=>{const f=await fixture(),o=await f.observe();assert.throws(()=>{o.pools[0].pool=P2;},TypeError);assert.throws(()=>assertCurrentObservation(structuredClone(o)),/NOT_ISSUED/);assert.equal(JSON.parse(observationJson(o)).executable,false);});
test('request is captured before asynchronous reads',async()=>{const f=await fixture(),r=request(),pending=f.observe(r);r.tokenOut=ACCOUNT;r.feeTiers.push(100);const o=await pending;assert.equal(o.request.tokenOut,B);assert.deepEqual(o.request.feeTiers,[5,30]);});
for(const [name,hook,code] of [
 ['fake factory',x=>x.method==='eth_getCode'&&x.params[0]===F?'0x6000':x.value,'FACTORY_CODE_MISMATCH'],
 ['missing pool code',x=>x.method==='eth_getCode'&&x.params[0]===P?'0x':x.value,'POOL_CODE_MISSING'],
 ['wrong factory getter',x=>x.method==='eth_call'&&isCall(x.params,'factory()',P)?'0x'+BigInt(F2).toString(16).padStart(64,'0'):x.value,'POOL_FACTORY_MISMATCH'],
 ['wrong token getter',x=>x.method==='eth_call'&&isCall(x.params,'token0()',P)?'0x'+BigInt(B).toString(16).padStart(64,'0'):x.value,'POOL_TOKEN_PAIR_MISMATCH'],
 ['wrong fee getter',x=>x.method==='eth_call'&&isCall(x.params,'feeBasisPoints()',P)?'0x'+uintWord(100n):x.value,'POOL_FEE_MISMATCH'],
 ['zero reserves',x=>x.method==='eth_call'&&isCall(x.params,'getReserves()',P)?'0x'+uintWord(0n)+uintWord(1000n)+uintWord(1n):x.value,'POOL_RESERVES_INVALID'],
 ['overflow reserves',x=>x.method==='eth_call'&&isCall(x.params,'getReserves()',P)?'0x'+uintWord(1n<<112n)+uintWord(1000n)+uintWord(1n):x.value,'POOL_RESERVES_INVALID'],
 ['quote mismatch',x=>x.method==='eth_call'&&isCall(x.params,'quoteExactIn(address,uint256)',P)?'0x'+uintWord(1n):x.value,'POOL_QUOTE_MISMATCH'],
 ['missing token code',x=>x.method==='eth_getCode'&&x.params[0]===A?'0x':x.value,'TOKEN_CODE_MISSING'],
 ['balance under reserve',x=>x.method==='eth_call'&&isCall(x.params,'balanceOf(address)',A)?'0x'+uintWord(1n):x.value,'POOL_BALANCES_UNSUPPORTED'],
 ['invalid ABI size',x=>x.method==='eth_call'&&isCall(x.params,'factory()',P)?x.value+'00':x.value,'ABI_RETURN_INVALID']
])test(`pool verifier rejects ${name}`,async()=>{const f=await fixture({hook}),o=await f.observe(request(),[candidate()]);assert.equal(o.pools.length,0);assert.ok(o.rejected.some(r=>r.code===code));});
test('RPC code disagreement aborts entire batch instead of retaining partial winners',async()=>{const f=await fixture({hook:x=>x.method==='eth_getCode'&&x.params[0]===F2&&x.index===1?'0x6000':x.value});await assert.rejects(f.observe(),/DISAGREEMENT/);});
test('reorg after pool reads discards all results',async()=>{const f=await fixture({hook:x=>{if(x.method==='eth_call'&&isCall(x.params,'quoteExactIn(address,uint256)'))x.block.hash=OTHER_H;return x.value;}});await assert.rejects(f.observe(),/REORG/);});
test('duplicate and foreign chain candidates are not double-counted',async()=>{const f=await fixture(),o=await f.observe(request(),[candidate(),candidate(),{...candidate(F2),chainId:'eip155:1'}]);assert.equal(o.pools.length,1);assert.ok(o.rejected.some(x=>x.code==='DUPLICATE_FACTORY'));assert.ok(o.rejected.some(x=>x.code==='CANDIDATE_CHAIN_OR_PROTOCOL'));});
test('excessive factory-tier budget refused rather than silently truncated',async()=>{const f=await fixture(),c=Array.from({length:17},(_,i)=>candidate('0x'+BigInt(i+1).toString(16).padStart(40,'0')));await assert.rejects(f.observe(request(),c),/BUDGET/);});
for(const patch of [{amountIn:0n},{amountIn:1n<<112n},{amountIn:'100'},{tokenIn:B},{slippageBps:1001},{feeTiers:[0]},{feeTiers:[5,5]},{chainId:'eip155:0'},{requestId:'x'},{unknown:true}])test(`request boundary ${Object.keys(patch).join()}`,()=>assert.throws(()=>parseDiscoveryRequest(request(patch))));
test('expired issued observations cannot split or export',async()=>{const f=await fixture(),o=await f.observe();f.setTime(NOW+30000);assert.throws(()=>planObservedGrossSplit(o),/EXPIRED/);assert.throws(()=>observationJson(o),/EXPIRED/);});
test('missing gas remains incomplete, never free',async()=>{const f=await fixture(),o=await f.observe(),rank=compareObservedPools(o);assert.equal(rank.bestRouteId,null);assert.equal(rank.incomplete.length,2);assert.ok(rank.incomplete[0].reasons.includes('ACCOUNT_SIMULATION_AND_GAS_MISSING'));});
test('read-only simulation with sufficient allowance never requests signing',async()=>{const f=await fixture(),o=await f.observe(),s=await simulateObservedPool(o,o.pools[0].routeId,{account:ACCOUNT,recipient:ACCOUNT});assert.equal(s.executable,false);assert.equal(s.gas.gasUnits,125000n);assert.ok(f.calls.every(x=>!x.method.includes('send')&&!x.method.includes('sign')));});
for(const [options,code] of [[{allowance:0n},'APPROVAL_REQUIRED'],[{balance:1n},'BALANCE_INSUFFICIENT']])test(`simulation stops on ${code}`,async()=>{const f=await fixture(options),o=await f.observe();await assert.rejects(simulateObservedPool(o,o.pools[0].routeId,{account:ACCOUNT,recipient:ACCOUNT}),new RegExp(code));assert.ok(!f.calls.some(x=>x.method==='eth_estimateGas'));});
test('return-value-only simulation cannot label recipient transfer behavior verified',async()=>{const f=await fixture(),o=await f.observe();await simulateObservedPool(o,o.pools[0].routeId,{account:ACCOUNT,recipient:ACCOUNT});assert.equal(o.tokenTransferBehaviorVerified,false);});
test('simulated wrong output rejected',async()=>{const f=await fixture({hook:x=>x.method==='eth_call'&&isCall(x.params,'swapExactIn(address,uint256,uint256,address,uint256)')?'0x'+uintWord(1n):x.value}),o=await f.observe();await assert.rejects(simulateObservedPool(o,o.pools[0].routeId,{account:ACCOUNT,recipient:ACCOUNT}),/SIMULATED_OUTPUT/);});
test('a fabricated or another observation simulation cannot price routes',async()=>{const f=await fixture(),o=await f.observe();assert.throws(()=>compareObservedPools(o,{simulations:[{routeId:o.pools[0].routeId,expiresAt:NOW+5000}]}),/SIMULATION_NOT_BOUND/);});
test('gas estimates without network-fee completeness or conversion stay incomplete',async()=>{const f=await fixture(),o=await f.observe(),s=await simulateObservedPool(o,o.pools[0].routeId,{account:ACCOUNT,recipient:ACCOUNT});const result=compareObservedPools(o,{simulations:[s],nativeAsset:'eip155:84532/slip44:60'});assert.equal(result.bestRouteId,null);assert.ok(result.incomplete.some(x=>x.reasons.includes('ADDITIONAL_NETWORK_FEES_NOT_ATTESTED')));});
test('net comparison requires caller-owned complete fee policy and current rate',async()=>{const f=await fixture(),o=await f.observe(),sims=await Promise.all(o.pools.map(p=>simulateObservedPool(o,p.routeId,{account:ACCOUNT,recipient:ACCOUNT})));const result=compareObservedPools(o,{simulations:sims,nativeAsset:'eip155:84532/slip44:60',networkFeeEvidence:sims.map(s=>feeAttestation(o,s)),rates:[{asset:'eip155:84532/slip44:60',outputAsset:`eip155:84532/erc20:${B}`,numerator:1n,denominator:1000000000000n,asOf:NOW,expiresAt:NOW+30000,source:'test-only-explicit-price'}]});assert.equal(result.ranked.length,2);assert.equal(result.bestRouteId,o.pools[1].routeId);assert.equal(result.executable,false);assert.equal(result.ranked[0].additionalCostOut,138n);});
test('real-observation grid split is exact only for gross objective, no gas-free claim',async()=>{const f=await fixture(),o=await f.observe(),s=planObservedGrossSplit(o);assert.equal(s.executable,false);assert.equal(s.costsExcluded,true);assert.equal(s.netOptimality,false);assert.equal(s.plan.allocations.reduce((a,x)=>a+x.amountIn,0n),o.request.amountIn);assert.ok(s.plan.minimumOut>=o.pools[1].minimumOut);});
test('split grid respects indivisible amount and bounded candidate budget',async()=>{const f=await fixture(),o=await f.observe(request({amountIn:101n}));assert.throws(()=>planObservedGrossSplit(o,{steps:100}),/NOT_ON_GRID/);});
test('independent brute-force enumerator matches observed 2-pool 100-step grid',async()=>{const f=await fixture(),o=await f.observe(),s=planObservedGrossSplit(o);let best=0n;for(let k=0;k<=100;k++){let out=0n;for(const [i,steps] of [[0,k],[1,100-k]])if(steps){const p=o.pools[i],n=BigInt(steps)*1000n,adjust=n*BigInt(10000-p.feeBps);out+=(adjust*p.reserveOut/(p.reserveIn*10000n+adjust))*9950n/10000n;}if(out>best)best=out;}assert.equal(s.plan.minimumOut,best);});

function feeAttestation(o,s,changes={}) {return {schema:'realdex.network-fee-attestation.v1',routeId:s.routeId,requestId:o.request.requestId,
  blockHash:o.anchor.hash,account:s.account,recipient:s.recipient,asOf:NOW,expiresAt:o.expiresAt,complete:true,source:'test-only-local-fee-model',costs:[],...changes};}
for(const nativeAsset of ['eip155:1/slip44:60','eip155:84532/slip44:60/extra','eip155:84532/slip44:060','eip155:84532/erc20:'+A])
  test(`native cost identity refused: ${nativeAsset}`,async()=>{const f=await fixture(),o=await f.observe();assert.throws(()=>compareObservedPools(o,{nativeAsset}),/NATIVE_ASSET_CHAIN_MISMATCH/);});
test('simulations for different accounts cannot be compared together',async()=>{
  const f=await fixture(),o=await f.observe(),first=await simulateObservedPool(o,o.pools[0].routeId,{account:ACCOUNT,recipient:ACCOUNT}),
    second=await simulateObservedPool(o,o.pools[1].routeId,{account:A,recipient:A});
  assert.throws(()=>compareObservedPools(o,{simulations:[first,second]}),/ACCOUNT_CONTEXT/);
});
for(const [patch,code] of [
  [{requestId:'wrong-request'},'CONTEXT'],[{blockHash:OTHER_H},'CONTEXT'],[{account:A},'CONTEXT'],[{recipient:A},'CONTEXT'],
  [{asOf:NOW+1},'TIME'],[{expiresAt:NOW},'TIME'],[{expiresAt:NOW+30001},'TIME'],[{complete:'yes'},'INVALID'],
  [{costs:[{id:'execution-gas',asset:`eip155:84532/erc20:${B}`,amount:1n}]},'COST'],
  [{costs:[{id:'extra',asset:`eip155:1/erc20:${B}`,amount:1n}]},'COST'],
  [{costs:[{id:'extra',asset:`eip155:84532/erc20:${B}`,amount:-1n}]},'AMOUNT'],
  [{costs:[{id:'extra',asset:`eip155:84532/erc20:${B}`,amount:1}]},'AMOUNT']
])test(`network fee attestation bound and checked: ${Object.keys(patch)[0]} / ${code}`,async()=>{
  const f=await fixture(),o=await f.observe(),s=await simulateObservedPool(o,o.pools[0].routeId,{account:ACCOUNT,recipient:ACCOUNT});
  assert.throws(()=>compareObservedPools(o,{simulations:[s],networkFeeEvidence:[feeAttestation(o,s,patch)]}),new RegExp(code));
});
test('additional L2-style fee estimate is included once and bounds quote lifetime',async()=>{
  const f=await fixture(),o=await f.observe(),s=await simulateObservedPool(o,o.pools[0].routeId,{account:ACCOUNT,recipient:ACCOUNT});
  const e=feeAttestation(o,s,{expiresAt:NOW+10000,costs:[{id:'additional-data-fee',asset:`eip155:84532/erc20:${B}`,amount:25n}]});
  const rank=compareObservedPools(o,{simulations:[s],nativeAsset:'eip155:84532/slip44:60',networkFeeEvidence:[e],rates:[{
    asset:'eip155:84532/slip44:60',outputAsset:`eip155:84532/erc20:${B}`,numerator:1n,denominator:1000000000000n,asOf:NOW,expiresAt:NOW+30000,source:'test-only-rate'}]});
  assert.equal(rank.ranked.length,1);assert.equal(rank.ranked[0].additionalCostOut,163n);assert.equal(rank.ranked[0].validUntil,NOW+10000);
  assert.equal(rank.futureFeeGuarantee,false);assert.match(rank.costEvidence,/not-oracle-verified/);assert.equal(rank.executable,false);
});
test('an incomplete fee attestation cannot manufacture a net winner',async()=>{
  const f=await fixture(),o=await f.observe(),s=await simulateObservedPool(o,o.pools[0].routeId,{account:ACCOUNT,recipient:ACCOUNT});
  const rank=compareObservedPools(o,{simulations:[s],networkFeeEvidence:[feeAttestation(o,s,{complete:false})]});assert.equal(rank.bestRouteId,null);
});

test('pool observation never claims constructor provenance or complete runtime identity',async()=>{
  const f=await fixture({hook:x=>x.method==='eth_getCode'&&x.params[0]===P?'0x6060604052600055':x.value}),o=await f.observe();
  assert.equal(o.pools.length,2);assert.equal(o.poolCreationProvenanceVerified,false);assert.equal(o.poolRuntimeIdentityVerified,false);assert.equal(o.executable,false);
  const exported=JSON.parse(observationJson(o));assert.equal(exported.poolCreationProvenanceVerified,false);
});
