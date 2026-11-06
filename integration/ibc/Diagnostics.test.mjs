/** Real local node error observations. These failures are deliberate negative tests,
 * not a reclassification of a previously failed bridge transaction. No broadcasts.
 */
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startChain} from './devnet.mjs';
import {endpointPair} from './wallet-fixture.mjs';
import {assertStoreFailure} from './save-failure.mjs';
import {IbcRpc} from '../../wallet/bridge/ibc-network.mjs';
import {validateCosmosNetwork} from '../../wallet/non-evm/cosmos-network.mjs';
import {vaultFixture, PASSWORD} from '../../wallet/test/fixtures.mjs';
let chain, proxies, network, rpc;
before(async()=>{
 chain=await startChain('diag');proxies=await endpointPair(chain);rpc=new IbcRpc();
 network=validateCosmosNetwork({family:'cosmos',id:'cosmos:'+chain.chainId,name:'Disposable read diagnostics',chainId:chain.chainId,hrp:'cosmos',endpoints:proxies.fault.endpoints,checkpoint:chain.checkpoint,denom:'stake',decimals:6,symbol:'STAKE-test',feeDenom:'stake',feeDecimals:6,maxTransferAtomic:'1000000000000',maxFeeAtomic:'1000000',maxGasLimit:'5000000',timeoutBlocks:100,minConfirmations:1,broadcastEnabled:false});
});
after(async t=>{
 try{if(proxies)t.diagnostic(JSON.stringify(proxies.fault.diagnostics.snapshot()));}
 finally{try{await proxies?.close();}finally{await chain?.close();}}
});
const balancePath=()=>`cosmos/bank/v1beta1/spendable_balances/${chain.relay}/by_denom?denom=stake`;
test('Real historic query is forwarded without rewriting its body, height or status',async()=>{
 const h=(await chain.head())-1;
 const r=await rpc.read(network,0,balancePath(),h);
 const original=await chain.state(balancePath(),h);
 assert.deepEqual(r,original);const trace=proxies.fault.diagnostics.snapshot().recent.at(-1);
 assert.equal(trace.status,200);assert.equal(trace.requestHeight,String(h));assert.equal(trace.responseHeight,String(h));assert.equal(proxies.fault.submissions,0);
});
test('Actual unavailable-height RPC error before storage injection remains primary and Vault stays unlocked',async t=>{
 const f=await vaultFixture();t.after(()=>f.close());const writer=f.store.write,h=(await chain.head())+1000;
 await assert.rejects(assertStoreFailure({store:f.store,vault:f.vault,
  operation:()=>rpc.read(network,0,balancePath(),h),submissions:()=>proxies.fault.submissions,
  unlock:()=>f.vault.unlock(PASSWORD)}),/^Error: COSMOS_RPC_HTTP_ERROR$/);
 assert.equal(f.store.write,writer);assert.equal(f.vault.status().locked,false);assert.equal(proxies.fault.submissions,0);
 const trace=proxies.fault.diagnostics.snapshot().lastFailure;
 assert.equal(trace.requestHeight,String(h));assert.ok(trace.status>=400);assert.equal(trace.route,'spendable-balance');
 assert.ok(!JSON.stringify(trace).includes(chain.relay));assert.ok(!JSON.stringify(trace).includes(chain.home));
});
test('Injected transport failure is visible and does not turn into a persistence success or a retry',async()=>{
 const count=proxies.fault.diagnostics.snapshot().total;
 proxies.fault.hook=async()=>{throw Error('PRIVATE_TRANSPORT_DETAILS');};
 try{await assert.rejects(rpc.read(network,0,balancePath(),1),/^Error: COSMOS_RPC_HTTP_ERROR$/);}
 finally{proxies.fault.hook=null;}
 const report=proxies.fault.diagnostics.snapshot();assert.equal(report.total,count+1);
 assert.equal(report.lastFailure.transportFailure,true);assert.equal(report.lastFailure.status,null);
 assert.equal(proxies.fault.submissions,0);assert.ok(!JSON.stringify(report).includes('PRIVATE_TRANSPORT_DETAILS'));
});
