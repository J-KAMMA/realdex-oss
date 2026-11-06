/** Actual two-chain fixture with explicit gas/result fault injection.
 * Only gas-fault tests modify a response. Normal stress uses actual responses.
 * All actors/funds are local disposable fixtures; no public endpoint or user key.
 */
import test,{before,after} from 'node:test';import assert from 'node:assert/strict';
import {ibcWalletFixture} from './wallet-fixture.mjs';
import {updateClient,receivePacket,acknowledgePacket,until} from './devnet.mjs';
import {simulateIbc} from '../../wallet/bridge/ibc-simulation.mjs';
import {ibcTransaction,ibcRaw} from '../../wallet/bridge/ibc-codec.mjs';
let f;let serial=0;
before(async()=>{f=await ibcWalletFixture();});
after(async t=>{try{if(f)t.diagnostic(JSON.stringify(f.diagnosticReport()));}finally{await f?.close();}});
const prepare=(i=0)=>f.call('ibc/prepare',{routeId:f.route.id,accountId:f.accounts[i].id,payment:f.payment(f.accounts[1].address,{requestKey:'simulation-'+serial++})});
const approve=p=>f.call('ibc/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.confirmationText,broadcast:true});
function gasFault(extra=45n){f.pa.mutate=({peer,type,path,text})=>{if(peer===1&&type==='rest'&&path==='/cosmos/tx/v1beta1/simulate'){const v=JSON.parse(text);v.gas_info.gas_used=String(BigInt(v.gas_info.gas_used)+extra);return JSON.stringify(v);}return text;};}
test('Real unsigned simulation reports conservative maximum for an explicitly injected gas-only difference',async()=>{
 const p=await prepare(),a=f.app.ibc.engine.publicAccount(f.vault.account(f.accounts[0].id));
 const tx=ibcTransaction(p.summary.transfer,a.publicKeyHex),raw=ibcRaw(tx,Buffer.alloc(64)).toString('base64');
 const h=await f.a.head();gasFault();
 try{
  const estimate=await simulateIbc(f.app.ibc.engine.rpc,f.route.source.network,raw,h,p.summary.transfer.gasLimit);
  assert.equal(estimate.estimatesDiffer,true);assert.equal(estimate.gasUsed,String(estimate.observedGasUsed.map(BigInt).reduce((a,b)=>a>b?a:b)));
  assert.equal(estimate.executionConfirmed,false);assert.equal(f.pa.submissions,0);
 }finally{f.pa.mutate=null;await f.call('reject',{id:p.id});}
});
test('Owner prepare/sign/send and actual proof-checked delivery succeed despite gas-only estimate variation',async()=>{
 const count=f.pa.submissions;gasFault();let r;
 try{const p=await prepare();r=(await approve(p)).record;assert.equal(f.pa.submissions,count+1);}
 finally{f.pa.mutate=null;}
 const source=await until(async()=>{const v=await f.call('ibc/reconcile',{id:r.id});return v.report.packet?v:false;});
 const received=await receivePacket(f.a,f.b,f.lane.bClient,source.report.packet);
 const ack=await acknowledgePacket(f.a,f.b,f.lane.aClient,source.report.packet,received.acknowledgement);
 const done=await f.call('ibc/reconcile',{id:r.id,destinationTxHash:received.result.hash,settlementTxHash:ack.hash});
 assert.equal(done.report.received,true,done.report.reason);assert.equal(done.report.completed,true);assert.equal(done.report.finalityProven,false);assert.equal(f.pa.submissions,count+1);
});
for(const [name,mutate,pattern]of [
 ['one estimate above signed cap',v=>v.gas_info.gas_used='2000001',/GAS_LIMIT/],
 ['same gas but changed result',v=>v.result.data=(v.result.data??'')+'changed',/DISAGREEMENT/],
 ['changed meter',v=>v.gas_info.gas_wanted=String(BigInt(v.gas_info.gas_wanted)-1n),/DISAGREEMENT/],
 ['missing result',v=>delete v.result,/SCHEMA_INVALID/]
])test('Actual owner path refuses '+name+' before recording or sending',async()=>{
 const count=f.pa.submissions,records=await f.vault.nonEvmRecords();
 f.pa.mutate=({peer,type,path,text})=>{if(peer===1&&type==='rest'&&path==='/cosmos/tx/v1beta1/simulate'){const v=JSON.parse(text);mutate(v);return JSON.stringify(v);}return text;};
 try{await assert.rejects(prepare(2),pattern);assert.equal(f.pa.submissions,count);assert.deepEqual(await f.vault.nonEvmRecords(),records);}
 finally{f.pa.mutate=null;}
});
test('Actual simulation HTTP failure remains a failure; there is no endpoint retry or submission',async()=>{
 const count=f.pa.submissions;let failed=0;
 f.pa.hook=async({peer,type,path})=>{if(peer===1&&type==='rest'&&path==='/cosmos/tx/v1beta1/simulate'){failed++;throw Error('TEST_LOCAL_TRANSPORT_FAILURE');}};
 try{await assert.rejects(prepare(2),/COSMOS_RPC_HTTP_ERROR/);assert.equal(failed,1);assert.equal(f.pa.submissions,count);}
 finally{f.pa.hook=null;}
});
test('Sixty normal prepares while local relayer state changes use original responses and no wallet send',async t=>{
 const count=f.pa.submissions;let stop=false,updates=0,updateFailure;
 const rpc=f.app.ibc.engine.rpc,originalRest=rpc.rest,batches=new Map();
 rpc.rest=async function(n,i,path,options){const v=await originalRest.call(this,n,i,path,options);
  if(path==='cosmos/tx/v1beta1/simulate'){const key=options.height+':'+options.body.tx_bytes;const seen=batches.get(key)??[];seen[i]=v.gas_info.gas_used;batches.set(key,seen);}return v;};
 const changing=(async()=>{try{while(!stop&&updates<20){await updateClient(f.a,f.b,f.lane.aClient,await f.b.head());updates++;}}catch(e){updateFailure=e;}})();
 let completed=0;
 try{for(let i=0;i<60;i++){const p=await prepare(3);await f.call('reject',{id:p.id});completed++;}}
 finally{stop=true;await changing;rpc.rest=originalRest;}
 if(updateFailure)throw updateFailure;
 assert.equal(completed,60);assert.equal(f.pa.submissions,count);assert.ok(updates>0);
 const observed=[...batches.values()].filter(v=>v.length===2&&v.every(x=>typeof x==='string'));
 t.diagnostic(JSON.stringify({readOnlyPrepares:completed,realRelayerUpdates:updates,walletSubmissions:0,responseMutation:false,simulationPairs:observed.length,gasOnlyVariations:observed.filter(v=>v[0]!==v[1]).length}));
});
