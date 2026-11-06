/** Actual compiled contracts and actual EVM state. Experimental profile is NOT a release gate. */
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from '../anvil/fixture.mjs';
import {environmentCompilation} from './compiler.mjs';
import {createMarket} from './market.mjs';
import {callData,read,uints,number,send,DEPLOYER,addr,deploy} from './abi.mjs';
import {validateNetwork} from '../../wallet/lib/network.mjs';
import {classifyEvmCall,evmTransaction} from '../../wallet/lib/transactions.mjs';
import {keccak256} from '../../node/verified/keccak.mjs';
import {deriveLocalPoolAddress} from '../../node/verified/create2.mjs';
let build;
before(()=> {build=environmentCompilation();if(process.env.REALDEX_AMM_EVIDENCE)fs.writeFileSync(process.env.REALDEX_AMM_EVIDENCE,JSON.stringify(build.evidence,null,2)+'\n',{flag:'wx'});});
async function setup(){return fixture({setupContracts:(chain,account)=>createMarket(chain,account,build)});}
async function submit(f,to,data) {const record=await f.submit({to,data,value:'0x0'});const receipt=await f.receipt(record.signed.transactionHash);assert.equal(receipt.status,'0x1');return record;}
async function approval(f,token,spender,amount) {return submit(f,token,callData('approve(address,uint256)',[spender,amount]));}
const until=async f=>BigInt((await f.chain.call('eth_getBlockByNumber',['latest',false])).timestamp)+180n;

test('AMM: actual Factory creates distinct fee pools and bidirectional mappings',async()=>{
 const f=await setup();try {const m=f.market;assert.notEqual(m.ab,m.ab5);assert.equal(addr(await read(f.chain,m.factory,'getPool(address,address,uint256)',[m.b,m.a,30n])),m.ab);assert.equal(await number(f.chain,m.factory,'allPoolsLength()'),3n);}finally{await f.close();}
});
test('AMM: compiler-derived CREATE2 and all immutable runtime bytes match the actual pool',async()=>{
 const f=await setup();try {const m=f.market,pc=build.output.contracts['contracts/LocalSwapPool.sol'].LocalSwapPool;
  const derived=deriveLocalPoolAddress({chainId:'eip155:31337',factory:m.factory,tokenA:m.a,tokenB:m.b,feeBps:30,poolCreationCode:'0x'+pc.evm.bytecode.object});assert.equal(derived.expectedPool,m.ab);
  const ast=build.output.sources['contracts/LocalSwapPool.sol'].ast.nodes.find(n=>n.nodeType==='ContractDefinition'&&n.name==='LocalSwapPool');
  const values={factory:BigInt(m.factory),token0:BigInt(derived.token0),token1:BigInt(derived.token1),feeBasisPoints:30n};const bytes=Buffer.from(pc.evm.deployedBytecode.object,'hex');
  for(const decl of ast.nodes.filter(n=>n.nodeType==='VariableDeclaration'&&n.mutability==='immutable'))for(const r of pc.evm.deployedBytecode.immutableReferences[decl.id]){assert.equal(r.length,32);Buffer.from(values[decl.name].toString(16).padStart(64,'0'),'hex').copy(bytes,r.start);}
  assert.equal(await f.chain.call('eth_getCode',[m.ab,'latest']),'0x'+bytes.toString('hex'));
  assert.equal(await f.chain.call('eth_getCode',[m.factory,'latest']),'0x'+build.output.contracts['contracts/LocalSwapFactory.sol'].LocalSwapFactory.evm.deployedBytecode.object);
 }finally{await f.close();}
});
test('AMM: owner HTTP performs separate approval and direct swap with exact actual balance deltas',async()=>{
 const f=await setup();try {const m=f.market,quoted=await f.owner('dex/quote',{chainId:'31337',quote:{tokenIn:m.a,tokenOut:m.b,amount:'0.001',slippageBps:50}});assert.equal(quoted.additionalFeesIncluded,false);
  const candidate=quoted.candidates.find(c=>c.pool===m.ab);assert.ok(candidate);
  async function confirm(operation){const sent=f.sent.length,p=await f.owner('dex/prepare',{accountId:f.account.id,chainId:'31337',operation});assert.equal(f.sent.length,sent);const r=await f.owner('approve',{id:p.id,intentId:p.intentId,confirm:p.summary.recipient,broadcast:true});assert.equal(f.sent.length,sent+1);assert.equal((await f.receipt(r.result.transactionHash)).status,'0x1');}
  await confirm({action:'approve',token:m.a,spender:m.ab,amount:'0.001'});
  const before=await m.balance(m.b,f.account.address),input=await m.balance(m.a,f.account.address);
  await confirm({action:'swap',pool:m.ab,tokenIn:m.a,amount:'0.001',minimumOutput:candidate.minimumOutput,recipient:f.account.address,ttlSeconds:180});
  assert.equal(await m.balance(m.b,f.account.address)-before,BigInt(candidate.outputAtomic));assert.equal(input-await m.balance(m.a,f.account.address),1000n);assert.equal(await m.allowance(m.a,f.account.address,m.ab),0n);
 }finally{await f.close();}
});
test('AMM: actual two-hop router swap leaves no intermediate balance or hop allowance',async()=>{
 const f=await setup();try {const m=f.market;await approval(f,m.a,m.router,1000n);const [out]=uints(await read(f.chain,m.router,'quoteExactIn(address[],address,uint256)',[[m.ab,m.bc],m.a,1000n]),2);
  const before=await m.balance(m.c,f.account.address);await submit(f,m.router,callData('swapExactIn(address[],address,uint256,uint256,address,uint256)',[[m.ab,m.bc],m.a,1000n,out,f.account.address,await until(f)]));
  assert.equal(await m.balance(m.c,f.account.address)-before,out);for(const token of [m.a,m.b,m.c])assert.equal(await m.balance(token,m.router),0n);
  assert.equal(await m.allowance(m.a,m.router,m.ab),0n);assert.equal(await m.allowance(m.b,m.router,m.bc),0n);
 }finally{await f.close();}
});
test('AMM: LP addition and withdrawal move real reserves, LP supply and both balances',async()=>{
 const f=await setup();try {const m=f.market,p=f.network.contracts.find(c=>c.address===m.ab);for(const t of [p.token0,p.token1])await approval(f,t,m.ab,200000n);
  const [r0,r1]=uints(await read(f.chain,m.ab,'getReserves()'),3),supply=await number(f.chain,m.ab,'totalSupply()');
  await submit(f,m.ab,callData('addLiquidity(uint256,uint256,uint256,address,uint256)',[200000n,200000n,200000n,f.account.address,await until(f)]));
  const shares=await m.balance(m.ab,f.account.address);assert.equal(shares,200000n);assert.equal(await number(f.chain,m.ab,'totalSupply()'),supply+shares);
  const before0=await m.balance(p.token0,f.account.address),before1=await m.balance(p.token1,f.account.address);
  await submit(f,m.ab,callData('removeLiquidity(uint256,uint256,uint256,address,uint256)',[shares,200000n,200000n,f.account.address,await until(f)]));
  assert.equal(await m.balance(p.token0,f.account.address)-before0,200000n);assert.equal(await m.balance(p.token1,f.account.address)-before1,200000n);assert.equal(await m.balance(m.ab,f.account.address),0n);assert.deepEqual(uints(await read(f.chain,m.ab,'getReserves()'),3).slice(0,2),[r0,r1]);
 }finally{await f.close();}
});
// Regressions: MUST fail on the v0.11 signing code before applying the fixes.
test('AMM regression: replacing a live nonzero approval is refused until explicit zero approval',async()=>{
 const f=await setup();try {const m=f.market;await approval(f,m.a,m.router,1000n);const count=f.sent.length;
  await assert.rejects(f.intent({to:m.a,data:callData('approve(address,uint256)',[m.router,2000n]),value:'0x0'}),/ALLOWANCE_RESET_REQUIRED/);
  assert.equal(f.sent.length,count);await approval(f,m.a,m.router,0n);assert.equal(await m.allowance(m.a,f.account.address,m.router),0n);await approval(f,m.a,m.router,2000n);assert.equal(await m.allowance(m.a,f.account.address,m.router),2000n);
 }finally{await f.close();}
});
test('AMM regression: a two-hop route with an unregistered middle token is refused',async()=>{
 const f=await setup();try {const m=f.market;const n=validateNetwork({...f.network,contracts:f.network.contracts.filter(c=>c.address!==m.b)});
  const t=evmTransaction({type:2,chainId:'31337',nonce:'0',gasLimit:'1000000',to:m.router,value:'0',data:callData('swapExactIn(address[],address,uint256,uint256,address,uint256)',[[m.ab,m.bc],m.a,1000n,1n,f.account.address,await until(f)]),maxFeePerGas:'3000000000',maxPriorityFeePerGas:'1000000000'});
  assert.throws(()=>classifyEvmCall(t,n),/TOKEN_NOT_IN_LOCAL_POLICY/);
 }finally{await f.close();}
});

test('AMM: new owner route-quote and route-swap HTTP flow produces exact two-hop output',async()=>{
 const f=await setup();try{const m=f.market,old=await f.vault.journal();
  const q=await f.owner('dex/quote-route',{chainId:'31337',quote:{router:m.router,pools:[m.ab,m.bc],tokenIn:m.a,amount:'0.001',slippageBps:50}});
  assert.equal(q.hops.length,2);assert.deepEqual(q.tokenPath,[m.a,m.b,m.c]);assert.equal(q.executionReady,false);assert.equal(q.additionalFeesIncluded,false);assert.deepEqual(await f.vault.journal(),old);
  await approval(f,m.a,m.router,1000n);const before=await m.balance(m.c,f.account.address),input=await m.balance(m.a,f.account.address),count=f.sent.length;
  const p=await f.owner('dex/prepare',{accountId:f.account.id,chainId:'31337',operation:{action:'route-swap',router:m.router,pools:[m.ab,m.bc],tokenIn:m.a,amount:'0.001',minimumOutput:q.minimumOutput,recipient:f.account.address,ttlSeconds:180}});
  assert.equal(f.sent.length,count);assert.ok(p.summary.contractPins.some(c=>c.address===m.b));
  const sent=await f.owner('approve',{id:p.id,intentId:p.intentId,confirm:f.account.address,broadcast:true});assert.equal((await f.receipt(sent.result.transactionHash)).status,'0x1');
  assert.equal(await m.balance(m.c,f.account.address)-before,BigInt(q.outputAtomic));assert.equal(input-await m.balance(m.a,f.account.address),1000n);
  assert.equal(await m.allowance(m.a,f.account.address,m.router),0n);
 }finally{await f.close();}
});
test('AMM: intermediate token code replacement after review blocks actual wallet signing',async()=>{
 const f=await setup();try{const m=f.market;await approval(f,m.a,m.router,1000n);
  const [out]=uints(await read(f.chain,m.router,'quoteExactIn(address[],address,uint256)',[[m.ab,m.bc],m.a,1000n]),2);
  const intent=await f.intent({to:m.router,value:'0x0',data:callData('swapExactIn(address[],address,uint256,uint256,address,uint256)',[[m.ab,m.bc],m.a,1000n,out,f.account.address,await until(f)])});
  const before=(await f.vault.journal()).length,count=f.sent.length,code=await f.chain.call('eth_getCode',[m.b,'latest']);
  // Anvil-only adversarial fault injection: keep callable code but change its identity.
  await f.chain.call('anvil_setCode',[m.b,code+'00']);
  await assert.rejects(f.app.engine.sign(f.vault,f.network,intent),/CODE_HASH|RUNTIME/);
  assert.equal((await f.vault.journal()).length,before);assert.equal(f.sent.length,count);
 }finally{await f.close();}
});
test('AMM: actual allowance changed after review is rechecked before the wallet signs',async()=>{
 const f=await setup();try{const m=f.market;const intent=await f.intent({to:m.a,value:'0x0',data:callData('approve(address,uint256)',[m.router,2000n])});
  await f.chain.call('anvil_impersonateAccount',[f.account.address]);
  const hash=await f.chain.call('eth_sendTransaction',[{from:f.account.address,to:m.a,data:callData('approve(address,uint256)',[m.router,1n]),gas:'0x100000'}]);assert.equal((await f.receipt(hash)).status,'0x1');
  await f.chain.call('anvil_stopImpersonatingAccount',[f.account.address]);
  // Nonce changed as well: neither reason permits using the stale intent.
  await assert.rejects(f.app.engine.sign(f.vault,f.network,intent),/NONCE_CHANGED|ALLOWANCE_RESET_REQUIRED/);
  const request={...intent.request};delete request.nonce;
  await assert.rejects(f.app.engine.prepare(f.network,f.account,request),/ALLOWANCE_RESET_REQUIRED/);assert.equal(f.sent.length,0);
 }finally{await f.close();}
});
test('AMM: market movement after owner review prevents a stale minimum from being signed',async()=>{
 const f=await setup();try{const m=f.market;await approval(f,m.a,m.ab,1000000n);const out=await number(f.chain,m.ab,'quoteExactIn(address,uint256)',[m.a,1000000n]);
  const intent=await f.intent({to:m.ab,value:'0x0',data:callData('swapExactIn(address,uint256,uint256,address,uint256)',[m.a,1000000n,out,f.account.address,await until(f)])});
  await send(f.chain,m.a,'approve(address,uint256)',[m.ab,100000000n]);await send(f.chain,m.ab,'swapExactIn(address,uint256,uint256,address,uint256)',[m.a,100000000n,1n,DEPLOYER,await until(f)]);
  const before=(await f.vault.journal()).length,count=f.sent.length;
  await assert.rejects(f.app.engine.sign(f.vault,f.network,intent));assert.equal((await f.vault.journal()).length,before);assert.equal(f.sent.length,count);
 }finally{await f.close();}
});
test('AMM: an impossible minimum reverts on actual EVM without changing token or LP balances',async()=>{
 const f=await setup();try{const m=f.market,amount=10000n;await send(f.chain,m.a,'approve(address,uint256)',[m.ab,amount]);
  const reserves=uints(await read(f.chain,m.ab,'getReserves()'),3),a=await m.balance(m.a,DEPLOYER),b=await m.balance(m.b,DEPLOYER),s=await number(f.chain,m.ab,'totalSupply()');
  const hash=await f.chain.call('eth_sendTransaction',[{from:DEPLOYER,to:m.ab,data:callData('swapExactIn(address,uint256,uint256,address,uint256)',[m.a,amount,100000000000n,DEPLOYER,await until(f)]),gas:'0x100000'}]);
  assert.equal((await f.receipt(hash)).status,'0x0');assert.equal(await m.balance(m.a,DEPLOYER),a);assert.equal(await m.balance(m.b,DEPLOYER),b);assert.equal(await number(f.chain,m.ab,'totalSupply()'),s);assert.deepEqual(uints(await read(f.chain,m.ab,'getReserves()'),3),reserves);
 }finally{await f.close();}
});
test('AMM: duplicate factory creation reverts while its pool mapping and count stay unchanged',async()=>{
 const f=await setup();try{const m=f.market,count=await number(f.chain,m.factory,'allPoolsLength()');
  const hash=await f.chain.call('eth_sendTransaction',[{from:DEPLOYER,to:m.factory,data:callData('createPool(address,address,uint256)',[m.b,m.a,30n]),gas:'0x700000'}]);
  assert.equal((await f.receipt(hash)).status,'0x0');assert.equal(await number(f.chain,m.factory,'allPoolsLength()'),count);assert.equal(addr(await read(f.chain,m.factory,'getPool(address,address,uint256)',[m.a,m.b,30n])),m.ab);
 }finally{await f.close();}
});
test('AMM: route quote refuses an actual unsynchronized token donation until explicit sync',async()=>{
 const f=await setup();try{const m=f.market,q={router:m.router,pools:[m.ab,m.bc],tokenIn:m.a,amount:'0.001',slippageBps:50};
  const {quoteLocalRoute}=await import('../../wallet/lib/dex.mjs');await send(f.chain,m.b,'transfer(address,uint256)',[m.ab,10000n]);
  await assert.rejects(quoteLocalRoute(f.app.engine,f.network,q),/POOL_BALANCE_RESERVE_MISMATCH/);
  await send(f.chain,m.ab,'sync()');const result=await quoteLocalRoute(f.app.engine,f.network,q);assert.ok(BigInt(result.outputAtomic)>0n);assert.equal(f.sent.length,0);
 }finally{await f.close();}
});
test('AMM: AI token transfer spends its token budget once for repeated request IDs',async()=>{
 const f=await setup();try{const m=f.market,client=await f.agent({asset:m.a});const recipient='0x3535353535353535353535353535353535353535',before=await m.balance(m.a,recipient);
  const request={idempotencyKey:'test-erc20-once',recipient,amountAtomic:'50'};const r=await client.transfer(request);const again=await client.transfer(request);
  assert.equal(f.sent.length,1);assert.equal((await f.receipt(r.transactionHash)).status,'0x1');assert.equal(await m.balance(m.a,recipient)-before,50n);assert.equal(r.requestId,again.requestId);
  await assert.rejects(client.transfer({...request,idempotencyKey:'over-token-cap',amountAtomic:'101'}));assert.equal(f.sent.length,1);
 }finally{await f.close();}
});

test('AMM: fee-on-transfer input is atomically refused by the actual Pool',async()=>{
 const f=await setup();try{const m=f.market;
  const tax=await deploy(f.chain,build,'contracts/test/FeeOnTransferERC20.sol','FeeOnTransferERC20',['Tax input test','TAX',6,100]);
  await send(f.chain,tax,'mint(address,uint256)',[DEPLOYER,1000000n]);
  await send(f.chain,m.factory,'createPool(address,address,uint256)',[tax,m.a,30n]);
  const pool=addr(await read(f.chain,m.factory,'getPool(address,address,uint256)',[tax,m.a,30n]));
  await send(f.chain,tax,'approve(address,uint256)',[pool,100000n]);await send(f.chain,m.a,'approve(address,uint256)',[pool,100000n]);
  const oldA=await m.balance(m.a,DEPLOYER),oldTax=await m.balance(tax,DEPLOYER),supply=await number(f.chain,tax,'totalSupply()');
  const hash=await f.chain.call('eth_sendTransaction',[{from:DEPLOYER,to:pool,data:callData('addLiquidity(uint256,uint256,uint256,address,uint256)',[100000n,100000n,1n,DEPLOYER,await until(f)]),gas:'0x700000'}]);
  assert.equal((await f.receipt(hash)).status,'0x0');assert.equal(await m.balance(m.a,DEPLOYER),oldA);assert.equal(await m.balance(tax,DEPLOYER),oldTax);assert.equal(await number(f.chain,tax,'totalSupply()'),supply);assert.equal(await number(f.chain,pool,'totalSupply()'),0n);
  assert.equal(await m.balance(tax,pool),0n);assert.equal(await m.balance(m.a,pool),0n);
 }finally{await f.close();}
});
