import test from 'node:test';
import assert from 'node:assert/strict';
import {observeSettlement, confirmationPolicy, uncertainObservation} from '../lib/settlement.mjs';
import {signEvmTransaction, abiAddress, abiWord} from '../lib/transactions.mjs';
import {keccak256} from '../../node/verified/keccak.mjs';
import {serverFixture, PASSWORD, KEY, TO, GENESIS, BLOCK} from './fixtures.mjs';
import {agentFixture, payment} from './agent-fixtures.mjs';

const hash=n=>'0x'+n.repeat(32),qty=n=>'0x'+BigInt(n).toString(16);
function model() {
  const transaction={type:2,chainId:'31337',nonce:'0',gasLimit:'25000',to:TO,value:'1',data:'0x',maxFeePerGas:'3000000000',maxPriorityFeePerGas:'1000000000'};
  const signed=signEvmTransaction(Buffer.from(KEY,'hex'),transaction);
  const record={id:'test-record',family:'evm',state:'broadcast',nonceKey:`evm:31337:${GENESIS}:${signed.from}:0`,summary:{chainId:'31337',from:signed.from,to:TO,nonce:'0',operation:'native-transfer',recipient:TO,amountAtomic:'1'},signed};
  const receipt={transactionHash:signed.transactionHash,from:signed.from,to:TO,blockHash:BLOCK,blockNumber:'0x10',transactionIndex:'0x0',status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x3b9aca00',logs:[]};
  const tx={hash:signed.transactionHash,from:signed.from,to:TO,blockHash:BLOCK,blockNumber:'0x10',transactionIndex:'0x0',type:'0x2',chainId:'0x7a69',nonce:'0x0',value:'0x1',input:'0x',gas:qty(25000),maxFeePerGas:qty(3000000000),maxPriorityFeePerGas:qty(1000000000),accessList:[]};
  const snapshot={number:'0x20',hash:hash('33')},blocks={'0x10':{number:'0x10',hash:BLOCK,transactions:[signed.transactionHash]},'0x20':{number:'0x20',hash:snapshot.hash,transactions:[]}};
  const m={record,receipt,tx,snapshot,blocks,network:{chainId:'31337',genesisHash:GENESIS},calls:[],tag:blocks['0x20']};
  m.rpc={snapshot:async()=>m.snapshot,agree:async(_n,method,params)=>{m.calls.push({method,params});if(m.hook)await m.hook(method,params);switch(method){case 'eth_getTransactionReceipt':return m.receipt;case 'eth_getTransactionByHash':return m.tx;case 'eth_getBlockByNumber':return ['safe','finalized'].includes(params[0])?m.tag:m.blocks[params[0]]??null;default:throw Error('UNEXPECTED_METHOD');}}};
  m.observe=()=>observeSettlement(m.rpc,m.network,m.record,1000);return m;
}
test('Default depth is explicit, and malformed depth/finality policies fail closed',()=>{
  assert.deepEqual(confirmationPolicy(),{minConfirmations:12,finalityTag:'none'});
  for(const value of [{minConfirmations:0,finalityTag:'none'},{minConfirmations:5000,finalityTag:'none'},{minConfirmations:2,finalityTag:'latest'},{minConfirmations:1,finalityTag:'none',trusted:true}])assert.throws(()=>confirmationPolicy(value));
});
test('Successful observation binds signed content, block membership and execution fee without claiming consensus',async()=>{
  const m=model(),r=await m.observe();assert.equal(r.confirmations,'17');assert.equal(r.policySatisfied,true);assert.equal(r.deliveryObserved,true);assert.equal(r.transactionContentMatched,true);assert.equal(r.finalityVerified,false);assert.equal(r.observedExecutionFeeWei,'21000000000000');assert.equal(r.actualBalanceChangeVerified,false);
});
test('A recent receipt is included but below the configured confirmation threshold',async()=>{
  const m=model();m.snapshot={number:'0x10',hash:BLOCK};const r=await m.observe();assert.equal(r.confirmations,'1');assert.equal(r.policySatisfied,false);
});
test('Safe/finalized tags are explicit node reports and must cover the receipt and be canonical',async()=>{
  for(const tag of ['safe','finalized']){const m=model();m.network.confirmationPolicy={minConfirmations:12,finalityTag:tag};const r=await m.observe();assert.equal(r.finalityTagSatisfied,true);assert.equal(r.policySatisfied,true);assert.equal(r.finalityVerified,false);}
  const m=model();m.network.confirmationPolicy={minConfirmations:1,finalityTag:'finalized'};m.tag={number:'0xf',hash:hash('44')};m.blocks['0xf']=m.tag;assert.equal((await m.observe()).policySatisfied,false);
});
for(const [name,patch,code] of [
  ['recipient',{to:'0x'+'55'.repeat(20)},'BINDING'],['value',{value:'0x2'},'CONTENT'],['calldata',{input:'0x01'},'CONTENT'],['nonce',{nonce:'0x1'},'CONTENT'],['chain',{chainId:'0x1'},'CONTENT'],['gas',{gas:'0x5208'},'CONTENT'],['fee',{maxFeePerGas:'0x1'},'FEE'],['access-list',{accessList:[{}]},'ACCESS_LIST'],['block',{blockHash:hash('55')},'BINDING']]){
  test(`Receipt cannot promote a transaction with changed ${name}`,async()=>{const m=model();Object.assign(m.tx,patch);await assert.rejects(m.observe(),new RegExp(code));});
}
test('Receipt without its transaction or correct block index is rejected',async()=>{
  const a=model();a.tx=null;await assert.rejects(a.observe(),/TRANSACTION_UNAVAILABLE/);
  const b=model();b.blocks['0x10'].transactions=[hash('66')];await assert.rejects(b.observe(),/INDEX_MISMATCH/);
});
test('Gas used and price must not exceed the signed transaction caps',async()=>{
  const m=model();m.receipt.gasUsed=qty(25001);await assert.rejects(m.observe(),/GAS_USAGE/);m.receipt.gasUsed='0x5208';m.receipt.effectiveGasPrice=qty(3000000001);await assert.rejects(m.observe(),/FEE_EXCEEDS/);
});
test('Log from another block/transaction and duplicate log indices are rejected',async()=>{
  const m=model();const log={address:TO,topics:[],data:'0x',transactionHash:m.signed?.transactionHash??m.record.signed.transactionHash,blockHash:BLOCK,blockNumber:'0x10',transactionIndex:'0x0',logIndex:'0x0',removed:false};
  m.receipt.logs=[{...log,transactionHash:hash('66')}];await assert.rejects(m.observe(),/LOG_BINDING/);
  m.receipt.logs=[log,log];await assert.rejects(m.observe(),/DUPLICATE_LOG/);
});
test('Changing the pinned common head during receipt inspection rejects the observation',async()=>{
  const m=model();m.hook=async(method)=>{if(method==='eth_getTransactionByHash')m.blocks['0x20']={number:'0x20',hash:hash('77'),transactions:[]};};await assert.rejects(m.observe(),/HEAD_CHANGED/);
});
test('Missing receipt removes current success; a changed old block is positive reorg evidence only',async()=>{
  const m=model();m.record.report=await m.observe();m.receipt=null;let r=await m.observe();assert.equal(r.transactionReportedSuccessful,null);assert.equal(r.deliveryObserved,false);assert.equal(r.reorgObserved,false);assert.equal(r.lastKnownReceipt.blockHash,BLOCK);
  m.blocks['0x10'].hash=hash('66');r=await m.observe();assert.equal(r.reorgObserved,true);assert.equal(r.observation,'receipt-missing-after-observed-reorg');assert.equal(r.policySatisfied,false);
});
test('A reverted receipt can meet depth without ever reporting asset delivery',async()=>{const m=model();m.receipt.status='0x0';const r=await m.observe();assert.equal(r.policySatisfied,true);assert.equal(r.transactionReportedSuccessful,false);assert.equal(r.deliveryObserved,false);});

test('HTTP receipt refresh is repeatable, survives restart, and clears stale success after disappearance',async()=>{
  const f=await serverFixture();try{
    const i=await f.app.engine.prepare(f.network,f.account,{from:f.account.address,to:TO,value:'0x1'});const r=await f.app.engine.sign(f.vault,f.network,i);f.state.knownSigned=[r.signed.rawTransaction];
    f.state.receipt={transactionHash:r.signed.transactionHash,from:f.account.address,to:TO,blockNumber:'0x10',blockHash:BLOCK,status:'0x1'};
    for(let n=0;n<3;n++)assert.equal((await f.call('reconcile',{id:r.id})).state,'reported-confirmed');
    f.vault.lock();await f.vault.unlock(PASSWORD);assert.equal((await f.call('reconcile',{id:r.id})).state,'reported-confirmed');
    f.state.receipt=null;f.state.block=hash('66');const missing=await f.call('reconcile',{id:r.id});assert.equal(missing.state,'broadcast-unknown');assert.equal(missing.report.reorgObserved,true);assert.equal(missing.report.transactionReportedSuccessful,null);assert.equal(f.state.sent.length,0);
  }finally{await f.close();}
});
test('RPC mismatch invalidates stored success and never submits or frees nonce',async()=>{
  const f=await serverFixture();try{
    const i=await f.app.engine.prepare(f.network,f.account,{from:f.account.address,to:TO,value:'0x1'});const r=await f.app.engine.sign(f.vault,f.network,i);f.state.knownSigned=[r.signed.rawTransaction];f.state.receipt={transactionHash:r.signed.transactionHash,from:f.account.address,to:TO,blockNumber:'0x10',blockHash:BLOCK,status:'0x1'};
    await f.call('reconcile',{id:r.id});f.state.secondMismatch='eth_getTransactionReceipt';await assert.rejects(f.call('reconcile',{id:r.id}),/RPC_DISAGREEMENT/);
    const journal=await f.vault.journal();assert.equal(journal[0].state,'broadcast-unknown');assert.equal(journal[0].report.policySatisfied,false);assert.equal(journal[0].nonceKey,r.nonceKey);assert.equal(f.state.sent.length,0);
  }finally{await f.close();}
});
test('Late observation cannot overwrite a different durable state',async()=>{
  const f=await serverFixture();try{
    const i=await f.app.engine.prepare(f.network,f.account,{from:f.account.address,to:TO,value:'0x1'});const r=await f.app.engine.sign(f.vault,f.network,i);await f.vault.updateRecord(r.id,'broadcast-unknown');
    await assert.rejects(f.vault.applyObservation(r,'reported-confirmed',{}),/OBSERVATION_SUPERSEDED/);
  }finally{await f.close();}
});
test('AI refresh rechecks previously successful receipts; reorg never refunds grant usage or retransmits',async()=>{
  const f=await agentFixture({mode:'auto'});try{
    const sent=await f.agent('transfer',payment());f.state.receipt={transactionHash:sent.transactionHash,from:f.account.address,to:TO,blockNumber:'0x10',blockHash:BLOCK,status:'0x1'};
    const input={idempotencyKey:'invoice-001',refresh:true};assert.equal((await f.agent('result',input)).broadcastState,'reported-confirmed');
    f.state.receipt=null;const r=await f.agent('result',input);assert.equal(r.broadcastState,'broadcast-unknown');assert.equal(r.receiptObservation.transactionReportedSuccessful,null);assert.equal(f.state.sent.length,1);assert.equal((await f.agent('status')).policy.usage.lifetimeAtomic,'50');
  }finally{await f.close();}
});

test('Lock during receipt recheck prevents a late observation from being persisted after re-unlock',async()=>{
  const f=await serverFixture();let release;
  try{
    const i=await f.app.engine.prepare(f.network,f.account,{from:f.account.address,to:TO,value:'0x1'});
    const r=await f.app.engine.sign(f.vault,f.network,i);f.state.knownSigned=[r.signed.rawTransaction];
    f.state.receipt={transactionHash:r.signed.transactionHash,from:f.account.address,to:TO,blockNumber:'0x10',blockHash:BLOCK,status:'0x1'};
    let enter;const entered=new Promise(resolve=>enter=resolve),held=new Promise(resolve=>release=resolve);
    f.state.delay=async method=>{if(method==='eth_getTransactionReceipt'){enter();await held;}};
    const pending=f.app.engine.reconcile(f.vault,f.network,r);const rejected=assert.rejects(pending,/LOCKED_DURING_RECHECK/);
    await entered;f.vault.lock();await f.vault.unlock(PASSWORD);release();await rejected;
    const [after]=await f.vault.journal();assert.equal(after.state,'signed');assert.deepEqual(after.report,r.report);assert.equal(f.state.sent.length,0);
  }finally{release?.();await f.close();}
});
test('Receipt re-included in a new canonical block remains the same transaction and updates its depth',async()=>{
  const m=model();m.record.report=await m.observe();
  const newHash=hash('88');m.receipt={...m.receipt,blockHash:newHash,blockNumber:'0x1f'};
  m.tx={...m.tx,blockHash:newHash,blockNumber:'0x1f'};
  m.blocks['0x1f']={hash:newHash,number:'0x1f',transactions:[m.record.signed.transactionHash]};
  const result=await m.observe();assert.equal(result.reorgObserved,true);assert.equal(result.confirmations,'2');
  assert.equal(result.policySatisfied,false);assert.equal(result.transactionContentMatched,true);
  assert.equal(result.lastKnownReceipt.blockHash,BLOCK);
});
