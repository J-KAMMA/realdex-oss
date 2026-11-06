/** Synthetic RPC protocol/boundary tests, not consensus or EVM tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {dexRequest,quoteLocalRoute} from '../lib/dex.mjs';
import {resolveLocalRoute,classifyEvmCall,abiWord,abiAddress,routerQuoteData} from '../lib/transactions.mjs';
import {validateNetwork} from '../lib/network.mjs';
import {selector,keccak256} from '../../node/verified/keccak.mjs';
import {serverFixture,TO,GENESIS,waitFor} from './fixtures.mjs';
const A='0x'+'a1'.repeat(20),B='0x'+'b1'.repeat(20),C='0x'+'c1'.repeat(20),P='0x'+'d1'.repeat(20),Q='0x'+'d2'.repeat(20),R='0x'+'e1'.repeat(20);
const CODE='0x6000',HASH=keccak256(CODE),RESERVE=1000000000n;
const contracts=[...[A,B,C].map((address,i)=>({address,kind:'erc20',runtimeHash:HASH,symbol:'T'+i,decimals:6,approvalCapAtomic:'1000000000000'})),
 {address:P,kind:'pool',runtimeHash:HASH,token0:A,token1:B},{address:Q,kind:'pool',runtimeHash:HASH,token0:B,token1:C},{address:R,kind:'router',runtimeHash:HASH}];
const network=validateNetwork({chainId:'31337',name:'SYNTHETIC route',symbol:'TEST',rpcUrls:['http://127.0.0.1:1/','http://127.0.0.1:2/'],genesisHash:GENESIS,contracts,maxSlippageBps:100,maxFeeWei:'10000000000000000',broadcastEnabled:true});
const query={router:R,pools:[P,Q],tokenIn:A,amount:'0.5',slippageBps:50};
const operation={action:'route-swap',router:R,pools:[P,Q],tokenIn:A,amount:'0.5',minimumOutput:'0.495',recipient:TO,ttlSeconds:180};
const account={id:'public-test',family:'evm',kind:'local',address:TO};
function quote(inAmount){const adjusted=inAmount*9970n;return adjusted*RESERVE/(RESERVE*10000n+adjusted);}
async function fixture(){
 const f=await serverFixture();f.network=validateNetwork({...f.network,contracts});f.app.settings={...f.app.settings,networks:[f.network]};
 f.state.callResponses={};f.state.estimate='0x60000';for(const c of contracts)f.state.code[c.address]=CODE;
 const reply=(to,sig,args,result)=>f.state.callResponses[to+':'+selector(sig)+args]=result;
 for(const t of [A,B,C])reply(t,'decimals()','','0x'+abiWord(6));
 let current=500000n;
 for(const [p,a,b]of [[P,A,B],[Q,B,C]]){
  reply(p,'token0()','','0x'+abiAddress(a));reply(p,'token1()','','0x'+abiAddress(b));reply(p,'feeBasisPoints()','','0x'+abiWord(30));
  reply(p,'getReserves()','','0x'+[RESERVE,RESERVE,1n].map(abiWord).join(''));
  for(const t of [a,b])reply(t,'balanceOf(address)',abiAddress(p),'0x'+abiWord(RESERVE));
  const next=quote(current);reply(p,'quoteExactIn(address,uint256)',abiAddress(a)+abiWord(current),'0x'+abiWord(next));current=next;
 }
 const routerData=routerQuoteData({pools:[P,Q],tokenIn:A,amountAtomic:'500000'});
 f.state.callResponses[R+':'+routerData]='0x'+abiWord(current)+abiAddress(C);f.state.callResult='0x'+abiWord(current);
 return Object.assign(f,{reply,output:current,routerData});
}
test('Route codec carries exactly the owner-selected path and all intermediate token pins',()=>{
 const built=dexRequest(network,account,operation),decoded=classifyEvmCall({...built.transaction,value:'0'},network);
 assert.equal(decoded.kind,'local-router-swap');assert.deepEqual(decoded.pools,[P,Q]);assert.equal(decoded.amountAtomic,'500000');assert.equal(decoded.tokenOut,C);
 assert.deepEqual(decoded.contractPins.filter(c=>c.kind==='erc20').map(c=>c.address),[A,B,C]);assert.deepEqual(built.details.tokenPath,[A,B,C]);assert.equal(built.details.automaticApproval,false);
});
for(const [label,patch,error]of [
 ['empty path',{pools:[]},/PATH_LENGTH/],['too many hops',{pools:[P,Q,P,Q,P]},/PATH_LENGTH/],['repeated pool',{pools:[P,P]},/REPEATED_POOL/],
 ['noncontiguous pools',{pools:[Q,P]},/POOL_PATH/],['unknown pool',{pools:[TO]},/POOL_NOT/],['unknown router',{router:TO},/ROUTER_NOT/],
 ['missing intermediate token',{},/TOKEN_NOT/],['unsupported fields',{data:'0x'},/SCHEMA_INVALID/],['zero minimum',{minimumOutput:'0'},/AMOUNT/],
 ['precision overflow',{amount:'0.0000001'},/DECIMAL|PRECISION/],['expired bound',{ttlSeconds:0},/DEADLINE/]]){
 test('Route rejects '+label,()=>{
  const n=label==='missing intermediate token'?{...network,contracts:contracts.filter(c=>c.address!==B)}:network;
  assert.throws(()=>dexRequest(n,account,{...operation,...patch}),error);
 });
}
test('Route prevents token cycles even with distinct pools',()=>{
 const n={...network,contracts:[...contracts,{address:TO,kind:'pool',runtimeHash:HASH,token0:A,token1:B}]};
 assert.throws(()=>resolveLocalRoute(n,R,[P,TO],A),/REPEATED_TOKEN/);
});
test('Owner route quote uses pinned blocks and two RPCs without writing to the vault or signing',async()=>{
 const f=await fixture();try{
  const old=f.store.read(),r=await f.call('dex/quote-route',{chainId:'31337',quote:query});
  assert.equal(r.outputAtomic,String(f.output));assert.equal(r.hops.length,2);assert.deepEqual(r.tokenPath,[A,B,C]);
  assert.equal(r.executionReady,false);assert.equal(r.additionalFeesIncluded,false);assert.equal(r.routeSearchPerformed,false);assert.equal(r.automaticApproval,false);
  assert.ok(BigInt(r.minimumOutputAtomic)*10000n>=f.output*9950n);assert.ok((BigInt(r.minimumOutputAtomic)-1n)*10000n<f.output*9950n);
  assert.deepEqual(f.store.read(),old);assert.equal(f.state.sent.length,0);assert.equal(f.app.requests.size,0);
  const reads=f.state.calls.filter(c=>c.method==='eth_call');assert.ok(reads.length>0);assert.ok(reads.every(c=>c.params[1]?.blockHash===r.blockHash&&c.params[1].requireCanonical===true));
 }finally{await f.close();}
});
for(const [label,mutate,error]of [
 ['changed middle code',f=>f.state.code[B]='0x6001',/CODE_HASH|RUNTIME/],
 ['changed middle decimals',f=>f.reply(B,'decimals()','','0x'+abiWord(18)),/DECIMALS_CHANGED/],
 ['wrong pool mapping',f=>f.reply(Q,'token0()','','0x'+abiAddress(C)),/ASSET_MAPPING/],
 ['changed fee',f=>f.reply(Q,'feeBasisPoints()','','0x'+abiWord(101)),/POOL_FEE_INVALID/],
 ['zero reserves',f=>f.reply(P,'getReserves()','','0x'+[0,RESERVE,1].map(abiWord).join('')),/RESERVES/],
 ['short balance',f=>f.reply(B,'balanceOf(address)',abiAddress(P),'0x'+abiWord(RESERVE-1n)),/BALANCE_RESERVE/],
 ['donation not synchronized',f=>f.reply(B,'balanceOf(address)',abiAddress(P),'0x'+abiWord(RESERVE+1n)),/BALANCE_RESERVE/],
 ['wrong hop formula',f=>f.reply(P,'quoteExactIn(address,uint256)',abiAddress(A)+abiWord(500000),'0x'+abiWord(1)),/POOL_QUOTE_FORMULA/],
 ['wrong router formula',f=>f.state.callResponses[R+':'+f.routerData]='0x'+abiWord(f.output+1n)+abiAddress(C),/ROUTER_QUOTE_FORMULA/],
 ['wrong final asset',f=>f.state.callResponses[R+':'+f.routerData]='0x'+abiWord(f.output)+abiAddress(B),/OUTPUT_ASSET/],
 ['RPC disagreement',f=>f.state.secondMismatch='eth_call',/RPC_DISAGREEMENT/]]){
 test('Route quote rejects '+label,async()=>{const f=await fixture();try{mutate(f);await assert.rejects(f.call('dex/quote-route',{chainId:'31337',quote:query}),error);assert.equal(f.state.sent.length,0);assert.equal(f.app.dexBusy,false);}finally{await f.close();}});
}
test('Owner route preparation stays unsigned and does not create token approvals',async()=>{
 const f=await fixture();try{const r=await f.call('dex/prepare',{accountId:f.account.id,chainId:'31337',operation});
  assert.equal(r.summary.operation,'local-router-swap');assert.ok(r.summary.contractPins.some(p=>p.address===B));assert.equal(r.automaticApproval,false);
  assert.equal(f.state.sent.length,0);assert.equal((await f.vault.journal()).length,0);assert.equal(f.app.requests.size,1);
 }finally{await f.close();}
});
test('Changed intermediate code after owner review prevents signing',async()=>{
 const f=await fixture();try{const p=await f.call('dex/prepare',{accountId:f.account.id,chainId:'31337',operation});f.state.code[B]='0x6001';
  await assert.rejects(f.call('approve',{id:p.id,intentId:p.intentId,confirm:TO,broadcast:true}),/CODE_HASH|RUNTIME/);assert.equal(f.state.sent.length,0);assert.equal((await f.vault.journal()).length,0);
 }finally{await f.close();}
});
test('Lock while a route quote is in flight rejects its late result and releases the busy flag',async()=>{
 const f=await fixture();try{let release,entered=false;const hold=new Promise(r=>release=r);f.state.delay=async m=>{if(m==='eth_call'){entered=true;await hold;}};
  const pending=f.call('dex/quote-route',{chainId:'31337',quote:query});await waitFor(()=>entered);f.vault.lock();release();
  await assert.rejects(pending,/WALLET_LOCKED/);assert.equal(f.app.dexBusy,false);assert.equal(f.state.sent.length,0);
 }finally{await f.close();}
});
test('Route expiry and canonical-block changes are rejected after reading',async()=>{
 const f=await fixture();try{
  const original=f.app.engine.rpc.agree.bind(f.app.engine.rpc);let count=0;
  f.app.engine.rpc.agree=async(...a)=>{const v=await original(...a);if(a[1]==='eth_getBlockByNumber'&&a[2][0]!=='0x0'&&++count===1)return {...v,hash:GENESIS};return v;};
  await assert.rejects(quoteLocalRoute(f.app.engine,f.network,query),/DEX_QUOTE_BLOCK_CHANGED/);
  f.app.engine.rpc.agree=original;let tick=0;f.app.engine.now=()=>f.state.now+(tick++?30001:0);
  await assert.rejects(quoteLocalRoute(f.app.engine,f.network,query),/DEX_QUOTE_EXPIRED/);
 }finally{await f.close();}
});
test('AI capability cannot access owner route quotation or route preparation',async()=>{
 const {agentFixture}=await import('./agent-fixtures.mjs');const f=await agentFixture({mode:'auto'});try{
  for(const path of ['dex/quote-route','dex/prepare']){const r=await fetch(f.start.origin+'/api/'+path,{method:'POST',headers:{origin:f.start.origin,'content-type':'application/json',authorization:'Bearer '+f.grant.token},body:JSON.stringify({chainId:'31337',quote:query})});assert.equal(r.status,401);}
  const r=await f.agentHttp('dex/quote-route',{quote:query});assert.ok(!r.ok);assert.equal(f.state.sent.length,0);
 }finally{await f.close();}
});
test('Live nonzero allowance fails both the initial preparation and the pre-signature recheck',async()=>{
 const f=await fixture();try{
  const approve=dexRequest(f.network,f.account,{action:'approve',token:A,spender:R,amount:'0.5'}).transaction;
  f.state.callResult='0x'+abiWord(1);const initial=await f.app.engine.prepare(f.network,f.account,approve);
  f.state.tokenAllowance=1;
  await assert.rejects(f.app.engine.prepare(f.network,f.account,approve),/ALLOWANCE_RESET_REQUIRED/);
  await assert.rejects(f.app.engine.sign(f.vault,f.network,initial),/ALLOWANCE_RESET_REQUIRED/);
  assert.equal((await f.vault.journal()).length,0);assert.equal(f.state.sent.length,0);
  const revoke=dexRequest(f.network,f.account,{action:'revoke',token:A,spender:R}).transaction;
  assert.equal((await f.app.engine.prepare(f.network,f.account,revoke)).summary.operation,'erc20-revoke');
 }finally{await f.close();}
});
test('Malformed allowance response is not interpreted as zero',async()=>{
 const f=await fixture();try{const d='0xdd62ed3e'+abiAddress(f.account.address)+abiAddress(R);f.state.callValues={[d]:'0x'};f.state.callResult='0x'+abiWord(1);
  await assert.rejects(f.app.engine.prepare(f.network,f.account,dexRequest(f.network,f.account,{action:'approve',token:A,spender:R,amount:'0.5'}).transaction),/TOKEN_ALLOWANCE_RESPONSE_INVALID/);
 }finally{await f.close();}
});
