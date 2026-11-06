import test from 'node:test';import assert from 'node:assert/strict';
import {FAMILIES} from '../chains/registry.mjs';
import {createChainReader} from '../chains/adapters.mjs';
import {observeChain,observeMany} from '../chains/observation.mjs';
import {profile,request,fetchFixture,NOW,H,IDS,registry} from './multichain-fixtures.mjs';
for(const family of FAMILIES){
 test(family+': native protocol observation with two explicit readers',async()=>{
  const log=[],result=await observeChain(request(family,{fetchImpl:fetchFixture(family,{log})}));
  assert.equal(result.family,family);assert.equal(result.executable,false);assert.equal(result.assurance.rpcAgreement,true);
  assert.equal(result.assurance.consensusProofVerified,false);assert.equal(result.assurance.independentOperatorsVerified,false);
  assert.equal(result.anchor.height,['evm','tezos'].includes(family)?'99':family==='bitcoin'?'95':'100');
  assert.equal(result.assurance.freshnessEstablished,family!=='substrate');assert(log.length>=6);assert(Object.isFrozen(result.anchor));
  assert(log.every(x=>!JSON.stringify(x.body).match(/sendRawTransaction|broadcast|submitTransaction|mutation|wallet_|eth_accounts/)));
 });
 test(family+': mismatching caller-pinned identity stops observation',async()=>{
  await assert.rejects(()=>observeChain(request(family,{genesisPin:'wrong-pinned-value'})),/GENESIS_PIN_MISMATCH/);
 });
 test(family+': refuses alias endpoints under one origin before I/O',async()=>{
  let called=false;await assert.rejects(()=>observeChain(request(family,{endpoints:['https://rpc.example/a?key=one','https://rpc.example/b?key=two'],fetchImpl:()=>{called=true;}})),/DISTINCT_RPC_ORIGINS_REQUIRED/);assert(!called);
 });
 test(family+': refuses unsafe external cleartext endpoints',async()=>{
  await assert.rejects(()=>observeChain(request(family,{endpoints:['http://public.example','https://two.example']})),/ENDPOINT_UNSAFE/);
 });
 test(family+': an already-aborted operation cannot emit an observation',async()=>{
  await assert.rejects(()=>observeChain(request(family,{signal:AbortSignal.abort()})));
 });
 test(family+': rejects wrong requested block height',async()=>{
  const reader=createChainReader(profile(family),'https://one.example',{fetchImpl:fetchFixture(family)});
  // The adapter API must preserve arbitrary heights rather than silently return latest.
  const at=await reader.at('42');assert.equal(at.height,'42');
 });
}
for(const family of ['solana','substrate','tron','ton'])test(family+': unknown genesis must not be learned by TOFU',async()=>{
 const r=request(family);delete r.genesisPin;await assert.rejects(()=>observeChain(r),/GENESIS_PIN_REQUIRED/);
});
test('every response identity is rechecked; changing EVM identity is rejected',async()=>{
 let count=0;const fetchImpl=fetchFixture('evm',{transform:(v,item)=>{if(item.body.method==='eth_chainId'&&++count>2)v.result='0x2';return v;}});
 await assert.rejects(()=>observeChain(request('evm',{fetchImpl})),/RPC_IDENTITY_CHANGED/);
});
test('anchor reorg detected after the first read',async()=>{
 let count=0;const fetchImpl=fetchFixture('evm',{transform:(v,item)=>{if(item.body.method==='eth_getBlockByNumber'&&item.body.params[0]==='0x63'&&++count>2)v.result.hash='0x'+H(8888);return v;}});
 await assert.rejects(()=>observeChain(request('evm',{fetchImpl})),/ANCHOR_CHANGED/);
});
test('RPC hash disagreement is not replaced by majority vote',async()=>{
 const fetchImpl=fetchFixture('evm',{transform:(v,item)=>{if(item.url.includes('two.')&&item.body.method==='eth_getBlockByNumber'&&item.body.params[0]==='0x63')v.result.hash='0x'+H(8888);return v;}});
 await assert.rejects(()=>observeChain(request('evm',{fetchImpl})),/RPC_ANCHOR_DISAGREEMENT/);
});
test('stale block timestamps cannot generate apparently fresh observations',async()=>{
 const fetchImpl=fetchFixture('evm',{transform:v=>{if(v.result?.timestamp)v.result.timestamp='0x1';return v;}});
 await assert.rejects(()=>observeChain(request('evm',{fetchImpl})),/BLOCK_STALE_OR_FUTURE/);
});
test('clock regression rejects all results',async()=>{
 let n=0;await assert.rejects(()=>observeChain(request('evm',{now:()=>NOW-(n++>0?1:0)})),/CLOCK_MOVED_BACKWARDS/);
});
test('skipped Solana slots fail closed without a latest fallback',async()=>{
 const fetchImpl=fetchFixture('solana',{transform:(v,item)=>{if(item.body.method==='getBlock')v.result=null;return v;}});
 await assert.rejects(()=>observeChain(request('solana',{fetchImpl})),/SOLANA_SKIPPED_OR_PRUNED_SLOT/);
});
test('XRPL unvalidated ledger is rejected',async()=>{
 const fetchImpl=fetchFixture('xrpl',{transform:v=>{if(v.result?.ledger)v.result.validated=false;return v;}});
 await assert.rejects(()=>observeChain(request('xrpl',{fetchImpl})),/XRPL_VALIDATED_LEDGER_REQUIRED/);
});
test('Starknet pending/preconfirmed payload cannot be treated as accepted',async()=>{
 const fetchImpl=fetchFixture('starknet',{transform:v=>{if(v.result?.block_hash)v.result.status='PRE_CONFIRMED';return v;}});
 await assert.rejects(()=>observeChain(request('starknet',{fetchImpl})),/STARKNET_ACCEPTED_BLOCK_REQUIRED/);
});
test('Cosmos block chain-id must match status identity',async()=>{
 const fetchImpl=fetchFixture('cosmos',{transform:v=>{if(v.result?.block)v.result.block.header.chain_id='wrong-chain';return v;}});
 await assert.rejects(()=>observeChain(request('cosmos',{fetchImpl})),/BLOCK_NETWORK_MISMATCH/);
});
test('parallel job results retain input order and bound concurrency',async()=>{
 const jobs=['evm','aptos','near'].map(f=>{const r=request(f);delete r.fetchImpl;delete r.now;r.endpoints=[`https://${f}-a.example`,`https://${f}-b.example`];return r;});
 let active=0,peak=0;const fetchImpl=async(url,init)=>{const family=new URL(url).hostname.split('-')[0];active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));try{return await fetchFixture(family)(url,init);}finally{active--;}};
 const results=await observeMany(jobs,{concurrency:1,fetchImpl,now:()=>NOW});assert(results.every(x=>x.ok));assert.deepEqual(results.map(x=>x.result.family),['evm','aptos','near']);assert(peak<=4);
});
for(const policy of [{ttlMs:0},{ttlMs:60001},{maxHeadGap:-1},{confirmationDepth:129},{extra:true},{maxAgeMs:NaN}])test('invalid policy rejected '+JSON.stringify(policy),async()=>{
 await assert.rejects(()=>observeChain(request('evm',{policy})),/POLICY_INVALID/);
});

test('Algorand digest with noncanonical base32 padding is rejected',async()=>{
 const fetchImpl=fetchFixture('algorand',{transform:v=>{if(v.blockHash)v.blockHash='A'.repeat(51)+'B';return v;}});
 await assert.rejects(()=>observeChain(request('algorand',{fetchImpl})),/HASH_INVALID/);
});
