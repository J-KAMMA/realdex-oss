import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,RECIPIENT} from './fixture.mjs';
const payment=key=>({idempotencyKey:key,recipient:RECIPIENT,amountAtomic:'50'});
for(const [label,type] of [['EIP-1559',2],['EIP-155 legacy',0]]) {
  test(`REAL EVM ${label}: wallet signature changes balance/nonce and receipt fee agrees`,async()=>{
    const f=await fixture();try {
      const before=await f.balance(RECIPIENT),sender=await f.balance(f.account.address);
      const record=await f.submit({type:'0x'+type.toString(16)});
      const result=await f.app.engine.reconcile(f.vault,f.network,record);
      assert.equal(result.state,'reported-confirmed');assert.equal(await f.balance(RECIPIENT)-before,50n);
      const receipt=await f.chain.call('eth_getTransactionReceipt',[record.signed.transactionHash]);
      assert.equal(sender-await f.balance(f.account.address),50n+BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice));
      assert.equal(await f.chain.call('eth_getTransactionCount',[f.account.address,'latest']),'0x1');
      assert.equal(f.sent.length,1);
    }finally{await f.close();}
  });
}
test('REAL EVM agent: preview does not sign; retrying the same request pays only once',async()=>{
  const f=await fixture();try {
    const client=await f.agent(),request=payment('real-idempotent');
    assert.equal((await client.preview(request)).canRequest,true);assert.equal(f.sent.length,0);
    assert.equal((await f.vault.journal()).length,0);
    const before=await f.balance(RECIPIENT),one=await client.transfer(request),two=await client.transfer(request);
    assert.equal(one.broadcastState,'broadcast');assert.equal(two.transactionHash,one.transactionHash);
    const result=await client.result(request.idempotencyKey,{refresh:true});
    assert.equal(result.broadcastState,'reported-confirmed');assert.equal(result.receiptObservation.policySatisfied,true);
    assert.equal(await f.balance(RECIPIENT)-before,50n);assert.equal(f.sent.length,1);
    assert.equal((await client.status()).policy.usage.lifetimeAtomic,'50');
  }finally{await f.close();}
});
test('REAL EVM agent: actual chain rollback removes delivery without refunding the allowance or resending',async()=>{
  const f=await fixture();try {
    const client=await f.agent(),request=payment('real-reorg'),snapshot=await f.chain.call('evm_snapshot');
    const before=await f.balance(RECIPIENT);await client.transfer(request);
    assert.equal((await client.result(request.idempotencyKey,{refresh:true})).broadcastState,'reported-confirmed');
    assert.equal(await f.balance(RECIPIENT)-before,50n);
    assert.equal(await f.chain.call('evm_revert',[snapshot]),true);
    const lost=await client.result(request.idempotencyKey,{refresh:true});
    assert.equal(lost.broadcastState,'broadcast-unknown');assert.equal(lost.receiptObservation.transactionReportedSuccessful,null);
    assert.equal(lost.receiptObservation.policySatisfied,false);assert.equal(await f.balance(RECIPIENT),before);
    assert.equal((await client.status()).policy.usage.lifetimeAtomic,'50');
    await client.transfer(request);assert.equal(f.sent.length,1);
  }finally{await f.close();}
});
test('REAL EVM agent: accepted transaction with lost HTTP response is reconciled, not paid twice',async()=>{
  const f=await fixture();try {
    const client=await f.agent(),request=payment('real-lost-response'),before=await f.balance(RECIPIENT);
    f.fault.dropSendResponse=true;
    const response=await client.transfer(request);
    assert.equal(response.broadcastState,'broadcast-unknown');
    await f.receipt(response.transactionHash); // RPC acceptance is not synchronous mining.
    assert.equal(await f.balance(RECIPIENT)-before,50n);assert.equal(f.sent.length,1);
    f.fault.dropSendResponse=false;
    assert.equal((await client.result(request.idempotencyKey,{refresh:true})).broadcastState,'reported-confirmed');
    await client.transfer(request);assert.equal(f.sent.length,1);assert.equal((await client.status()).policy.usage.lifetimeAtomic,'50');
  }finally{await f.close();}
});
test('REAL EVM pending transaction: no delivery until mined; pending nonce blocks a second payment',async()=>{
  const f=await fixture();try {
    await f.chain.call('evm_setAutomine',[false]);const before=await f.balance(RECIPIENT),record=await f.submit();
    assert.equal(await f.balance(RECIPIENT),before);
    assert.equal((await f.app.engine.reconcile(f.vault,f.network,record)).state,'broadcast-unknown');
    await assert.rejects(f.intent(),/PENDING_NONCE_REQUIRES_RECONCILIATION/);
    await f.chain.call('evm_mine');
    assert.equal((await f.app.engine.reconcile(f.vault,f.network,record)).state,'reported-confirmed');
    assert.equal(await f.balance(RECIPIENT)-before,50n);assert.equal(f.sent.length,1);
  }finally{await f.close();}
});
test('REAL EVM signing recheck rejects an actual nonce change after preview',async()=>{
  const f=await fixture();try {
    const intent=await f.intent();await f.chain.call('anvil_setNonce',[f.account.address,'0x1']);
    await assert.rejects(f.app.engine.sign(f.vault,f.network,intent),/NONCE_CHANGED/);
    assert.equal((await f.vault.journal()).length,0);assert.equal(f.sent.length,0);
  }finally{await f.close();}
});
test('REAL EVM native transfer refuses a recipient with deployed bytecode',async()=>{
  const f=await fixture();try {
    // Explicit real-EVM state mutation installs STOP; not a Solidity/AMM compilation test.
    await f.chain.call('anvil_setCode',[RECIPIENT,'0x00']);
    await assert.rejects(f.intent(),/NATIVE_CONTRACT_TRANSFER_UNSUPPORTED/);assert.equal(f.sent.length,0);
  }finally{await f.close();}
});
test('REAL EVM agent budget/recipient constraints reject before broadcast',async()=>{
  const f=await fixture();try {
    const client=await f.agent();
    await assert.rejects(client.transfer({...payment('real-too-much'),amountAtomic:'101'}));
    await assert.rejects(client.transfer({...payment('real-wrong-recipient'),recipient:'0x3636363636363636363636363636363636363636'}));
    assert.equal(f.sent.length,0);assert.equal(await f.chain.call('eth_getTransactionCount',[f.account.address,'latest']),'0x0');
  }finally{await f.close();}
});
test('REAL EVM journal is bound to genesis and cannot be replayed onto another configured chain instance',async()=>{
  const f=await fixture();try {
    const record=await f.app.engine.sign(f.vault,f.network,await f.intent());
    await assert.rejects(f.app.engine.broadcast(f.vault,{...f.network,genesisHash:'0x'+'12'.repeat(32)},record),/JOURNAL_GENESIS_BINDING_MISMATCH/);
    assert.equal(f.sent.length,0);assert.equal(await f.chain.call('eth_getTransactionCount',[f.account.address,'latest']),'0x0');
  }finally{await f.close();}
});

test('REAL EVM concurrent agent requests cannot exceed a single-payment lifetime allowance',async()=>{
  const f=await fixture();try {
    const client=await f.agent({limits:{perTransferAtomic:'50',rolling24hAtomic:'50',lifetimeAtomic:'50',perTxFeeWei:'1000000000000000',rolling24hFeeWei:'2000000000000000',lifetimeFeeWei:'2000000000000000',maxTransfers:1,minIntervalMs:0}});
    const before=await f.balance(RECIPIENT);
    const results=await Promise.allSettled([client.transfer(payment('parallel-a')),client.transfer(payment('parallel-b'))]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.filter(r=>r.status==='rejected').length,1);
    const paid=results.find(r=>r.status==='fulfilled').value;await f.receipt(paid.transactionHash);
    assert.equal(f.sent.length,1);assert.equal(await f.balance(RECIPIENT)-before,50n);
    assert.equal((await client.status()).policy.usage.lifetimeAtomic,'50');
  }finally{await f.close();}
});
test('REAL EVM confirmation depth remains unsatisfied until actual additional blocks are mined',async()=>{
  const f=await fixture();try {
    const record=await f.submit(),network={...f.network,confirmationPolicy:{minConfirmations:3,finalityTag:'none'}};
    await f.receipt(record.signed.transactionHash);
    const early=await f.app.engine.reconcile(f.vault,network,record);
    assert.equal(early.report.confirmations,'1');assert.equal(early.report.policySatisfied,false);
    await f.chain.call('evm_mine');await f.chain.call('evm_mine');
    const later=await f.app.engine.reconcile(f.vault,network,record);
    assert.equal(later.report.confirmations,'3');assert.equal(later.report.policySatisfied,true);
    assert.equal(later.report.finalityVerified,false);assert.equal(f.sent.length,1);
  }finally{await f.close();}
});
test('REAL EVM bytecode change after review is rejected by the pre-sign recheck',async()=>{
  const f=await fixture();try {
    const intent=await f.intent();await f.chain.call('anvil_setCode',[RECIPIENT,'0x00']);
    await assert.rejects(f.app.engine.sign(f.vault,f.network,intent),/NATIVE_CONTRACT_TRANSFER_UNSUPPORTED/);
    assert.equal(f.sent.length,0);assert.equal((await f.vault.journal()).length,0);
  }finally{await f.close();}
});
test('REAL EVM owner lock after durable signature prevents network transmission',async()=>{
  const f=await fixture();try {
    const record=await f.app.engine.sign(f.vault,f.network,await f.intent());f.vault.lock();
    await assert.rejects(f.app.engine.broadcast(f.vault,f.network,record),/VAULT_LOCKED/);
    assert.equal(f.sent.length,0);assert.equal(await f.chain.call('eth_getTransactionCount',[f.account.address,'latest']),'0x0');
  }finally{await f.close();}
});
test('REAL EVM current-backup restore retains nonce reservation after chain rollback',async()=>{
  const {PrivateStore}=await import('../../wallet/lib/storage.mjs');
  const {Vault}=await import('../../wallet/lib/vault.mjs');
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
  const {PASSWORD}=await import('./fixture.mjs');
  const f=await fixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-restored-real-'));
  let store,vault;
  try {
    const snapshot=await f.chain.call('evm_snapshot'),record=await f.submit();await f.receipt(record.signed.transactionHash);
    const backup=await f.vault.backup();
    store=new PrivateStore(directory);vault=new Vault(store);await vault.restore(backup.encrypted,PASSWORD);await vault.unlock(PASSWORD);
    const current=await vault.backup();await vault.verifyBackup(current.encrypted,PASSWORD);
    assert.equal((await vault.journal())[0].signed.transactionHash,record.signed.transactionHash);
    await f.chain.call('evm_revert',[snapshot]);
    const intent=await f.app.engine.prepare(f.network,vault.account(f.account.id),{from:f.account.address,to:RECIPIENT,value:'0x32'});
    await assert.rejects(f.app.engine.sign(vault,f.network,intent),/NONCE_ALREADY_RESERVED/);
    assert.equal(f.sent.length,1);
  }finally{vault?.lock();store?.close();fs.rmSync(directory,{recursive:true,force:true});await f.close();}
});
