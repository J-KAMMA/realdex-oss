import test from 'node:test';import assert from 'node:assert/strict';
import {dexRequest,dexCatalog,quoteDirectPools} from '../lib/dex.mjs';
import {classifyEvmCall,abiWord,abiAddress} from '../lib/transactions.mjs';
import {validateNetwork} from '../lib/network.mjs';
import {selector,keccak256} from '../../node/verified/keccak.mjs';
import {serverFixture,TO,GENESIS,BLOCK} from './fixtures.mjs';
const A='0x'+'aa'.repeat(20),B='0x'+'bb'.repeat(20),P='0x'+'cc'.repeat(20),Q='0x'+'cd'.repeat(20),F='0x'+'ee'.repeat(20),R='0x'+'dd'.repeat(20),CODE='0x6000',HASH=keccak256(CODE);
const contracts=[{address:A,kind:'erc20',runtimeHash:HASH,symbol:'A6',decimals:6,approvalCapAtomic:'1000000000000000000000000'},
  {address:B,kind:'erc20',runtimeHash:HASH,symbol:'B18',decimals:18,approvalCapAtomic:'1000000000000000000000000'},
  ...[P,Q].map(address=>({address,kind:'pool',runtimeHash:HASH,token0:A,token1:B})),{address:F,kind:'factory',runtimeHash:HASH},{address:R,kind:'router',runtimeHash:HASH}];
const network=validateNetwork({chainId:'31337',name:'SYNTHETIC',symbol:'TEST',rpcUrls:['http://127.0.0.1:1/','http://127.0.0.1:2/'],genesisHash:GENESIS,broadcastEnabled:true,maxFeeWei:'10000000000000000',maxSlippageBps:100,contracts});
const account={family:'evm',kind:'local',address:TO,id:'public-test'},now=1788560000000;
const common={pool:P,recipient:TO,ttlSeconds:180};
const forms=[
  [{action:'create-pool',factory:F,tokenA:A,tokenB:B,feeBps:30},'local-factory-create-pool'],
  [{action:'approve',token:A,spender:P,amount:'1.25'},'erc20-approve'],
  [{action:'revoke',token:A,spender:R},'erc20-revoke'],
  [{action:'swap',...common,tokenIn:A,amount:'1.25',minimumOutput:'2.4'},'local-pool-swap'],
  [{action:'add-liquidity',...common,amount0:'1.25',amount1:'2.5',minimumShares:'0.000000001'},'local-pool-add-liquidity'],
  [{action:'remove-liquidity',...common,shares:'0.000000001',minimum0:'1.2',minimum1:'2.4'},'local-pool-remove-liquidity']];
for(const [form,kind] of forms)test('Owner structured DEX request: '+kind,()=>{
  const {transaction,details}=dexRequest(network,account,form,now);
  const decoded=classifyEvmCall({...transaction,value:'0'},network,{now});assert.equal(decoded.kind,kind);assert.equal(transaction.from,TO);
  if(kind==='local-pool-swap'){assert.equal(decoded.amountAtomic,'1250000');assert.equal(decoded.minimumOutputAtomic,'2400000000000000000');assert.equal(details.deadline,String(now/1000+180));}
  if(kind==='local-factory-create-pool')assert.equal(decoded.details.createdPoolAutomaticallyTrusted,false);
});
test('Structured DEX rejects unknown fields/contracts, wrong units, zero minima and unsupported actions',()=>{
  const base=forms[3][0];for(const patch of [{data:'0x'},{pool:TO},{tokenIn:TO},{amount:'1.0000001'},{minimumOutput:'0'},{ttlSeconds:601},{recipient:'bad'},{action:'bridge'},{action:'raw'}])assert.throws(()=>dexRequest(network,account,{...base,...patch},now));
  assert.throws(()=>dexRequest(network,{...account,kind:'watch'},base,now));
  assert.throws(()=>dexRequest(network,account,{action:'approve',token:A,spender:TO,amount:'1'},now));
  assert.throws(()=>dexRequest(network,account,{action:'approve',token:A,spender:P,amount:'10000000000000000000'},now));
});
test('DEX catalog exposes only local registered policy, no RPC URLs or automatic discovery promotion',()=>{
  const r=dexCatalog(network);assert.equal(r.automaticCandidatePromotion,false);assert.equal(r.pools.length,2);assert.equal(r.factories.length,1);assert.ok(!JSON.stringify(r).includes('http'));assert.equal(r.tokens[0].decimals,6);
});
async function fixture(){
  const f=await serverFixture();const n=validateNetwork({...f.network,contracts});f.app.settings={...f.app.settings,networks:[n]};f.network=n;
  for(const c of contracts)f.state.code[c.address]=CODE;f.state.callResponses={};f.state.estimate='0x186a0';
  const reply=(to,signature,args,result)=>f.state.callResponses[to+':'+selector(signature)+args]=result;
  for(const t of contracts.filter(c=>c.kind==='erc20'))reply(t.address,'decimals()','','0x'+abiWord(t.decimals));
  const reserves=[1000000000000n,2000000000000000000000000n],amount=1250000n;
  const outputs={};for(const [pool,fee]of [[P,30n],[Q,5n]]){
    reply(pool,'token0()','','0x'+abiAddress(A));reply(pool,'token1()','','0x'+abiAddress(B));reply(pool,'feeBasisPoints()','','0x'+abiWord(fee));reply(pool,'getReserves()','','0x'+[...reserves,1n].map(abiWord).join(''));
    const adjusted=amount*(10000n-fee),output=adjusted*reserves[1]/(reserves[0]*10000n+adjusted);outputs[pool]=output;
    reply(pool,'quoteExactIn(address,uint256)',abiAddress(A)+abiWord(amount),'0x'+abiWord(output));
  }
  return Object.assign(f,{reply,outputs});
}
const quote={tokenIn:A,tokenOut:B,amount:'1.25',slippageBps:50};
test('Actual local HTTP direct-pair quote sorts gross outputs and rounds minimum upward without reservations',async()=>{
  const f=await fixture();try{
    const before=f.store.read(),r=await f.call('dex/quote',{chainId:'31337',quote});
    assert.equal(r.highestGrossOutputPool,Q);assert.equal(r.additionalFeesIncluded,false);assert.equal(r.executionReady,false);assert.equal(r.comparisonComplete,true);assert.equal(r.genesisHash,GENESIS);
    for(const c of r.candidates){assert.ok(BigInt(c.minimumOutputAtomic)*10000n>=BigInt(c.outputAtomic)*9950n);assert.ok((BigInt(c.minimumOutputAtomic)-1n)*10000n<BigInt(c.outputAtomic)*9950n);}
    assert.equal(f.state.sent.length,0);assert.equal(f.app.requests.size,0);assert.deepEqual(f.store.read(),before);
  }finally{await f.close();}
});
test('A pool quote with the wrong formula is excluded, not silently selected as the best',async()=>{
  const f=await fixture();try{f.reply(Q,'quoteExactIn(address,uint256)',abiAddress(A)+abiWord(1250000),'0x'+abiWord(f.outputs[Q]+1n));
    const r=await f.call('dex/quote',{chainId:'31337',quote});assert.equal(r.highestGrossOutputPool,P);assert.equal(r.comparisonComplete,false);assert.equal(r.excluded[0].error,'POOL_QUOTE_FORMULA_MISMATCH');
  }finally{await f.close();}
});
test('Code identity and token decimals are checked; changed pair mapping cannot yield a candidate',async()=>{
  const f=await fixture();try{
    f.reply(P,'token0()','','0x'+abiAddress(B));let r=await f.call('dex/quote',{chainId:'31337',quote});assert.equal(r.excluded[0].error,'POOL_ASSET_MAPPING_MISMATCH');
    f.state.code[Q]='0x6001';r=await f.call('dex/quote',{chainId:'31337',quote});assert.equal(r.candidates.length,0);
    f.reply(A,'decimals()','','0x'+abiWord(18));await assert.rejects(f.call('dex/quote',{chainId:'31337',quote}),/TOKEN_DECIMALS_CHANGED/);
  }finally{await f.close();}
});
test('Structured owner swap remains pending until exact recipient confirmation; no automatic token approval',async()=>{
  const f=await fixture();try{
    const r=await f.call('dex/quote',{chainId:'31337',quote}),selected=r.candidates[0];
    const operation={action:'swap',pool:selected.pool,tokenIn:A,amount:'1.25',minimumOutput:selected.minimumOutput,recipient:TO,ttlSeconds:180};
    const built=dexRequest(f.network,f.account,operation,f.state.now);f.state.callResponses[built.transaction.to+':'+built.transaction.data]='0x'+abiWord(f.outputs[Q]);
    const pending=await f.call('dex/prepare',{accountId:f.account.id,chainId:'31337',operation});assert.equal(pending.summary.operation,'local-pool-swap');assert.equal(pending.automaticApproval,false);assert.equal(f.state.sent.length,0);assert.equal((await f.vault.journal()).length,0);
    const sent=await f.call('approve',{id:pending.id,intentId:pending.intentId,confirm:TO,broadcast:true});assert.equal(sent.broadcastState,'broadcast');assert.equal(f.state.sent.length,1);assert.equal((await f.vault.journal()).length,1);
  }finally{await f.close();}
});
test('Factory creation preview cannot automatically register its simulated new pool',async()=>{
  const f=await fixture();try{const operation=forms[0][0],built=dexRequest(f.network,f.account,operation,f.state.now);f.state.callResponses[F+':'+built.transaction.data]='0x'+abiAddress(Q);
    const before=JSON.stringify(f.app.settings),pending=await f.call('dex/prepare',{accountId:f.account.id,chainId:'31337',operation});
    assert.equal(pending.summary.details.createdPoolAutomaticallyTrusted,false);assert.equal(JSON.stringify(f.app.settings),before);assert.equal(f.state.sent.length,0);
  }finally{await f.close();}
});
test('Locked wallet and oversized slippage are denied before DEX signing; quote is never sent',async()=>{
  const f=await fixture();try{await assert.rejects(f.call('dex/quote',{chainId:'31337',quote:{...quote,slippageBps:101}}),/SLIPPAGE/);
    f.vault.lock();await assert.rejects(f.call('dex/catalog',{chainId:'31337'}),/VAULT_LOCKED/);assert.equal(f.state.sent.length,0);
  }finally{await f.close();}
});

test('Token decimals changed after owner review invalidate the swap before signing, not just a transfer',async()=>{
  const f=await fixture();try{
    const quoted=await f.call('dex/quote',{chainId:'31337',quote}),selected=quoted.candidates[0];
    const operation={action:'swap',pool:selected.pool,tokenIn:A,amount:'1.25',minimumOutput:selected.minimumOutput,recipient:TO,ttlSeconds:180};
    const built=dexRequest(f.network,f.account,operation,f.state.now);f.state.callResponses[built.transaction.to+':'+built.transaction.data]='0x'+abiWord(f.outputs[Q]);
    const pending=await f.call('dex/prepare',{accountId:f.account.id,chainId:'31337',operation});
    f.reply(A,'decimals()','','0x'+abiWord(18));
    await assert.rejects(f.call('approve',{id:pending.id,intentId:pending.intentId,confirm:TO,broadcast:true}),/TOKEN_DECIMALS_CHANGED/);
    assert.equal(f.state.sent.length,0);assert.equal((await f.vault.journal()).length,0);
  }finally{await f.close();}
});
test('Agent transfer grants cannot use the owner DEX routes or access the owner capability',async()=>{
  const {agentFixture}=await import('./agent-fixtures.mjs');const f=await agentFixture({mode:'auto'});try{
    await assert.rejects(f.agent('dex/prepare',{accountId:f.account.id,chainId:'31337',operation:forms[0][0]}),/AGENT_METHOD_DENIED/);
    const r=await fetch(f.start.origin+'/api/dex/catalog',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+f.grant.token,origin:f.start.origin},body:JSON.stringify({chainId:'31337'})});
    assert.equal(r.status,401);assert.equal((await r.json()).error,'UI_AUTH_REQUIRED');assert.equal(f.state.sent.length,0);
  }finally{await f.close();}
});
