import test from 'node:test';
import assert from 'node:assert/strict';
import {Vault, MAX_VAULT_PENDING_OPERATIONS, MAX_VAULT_PLAINTEXT_BYTES} from '../lib/vault.mjs';
import {vaultFixture, storeFixture, PASSWORD, TO} from './fixtures.mjs';
import {signEvmTransaction} from '../lib/transactions.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
const tx = {type:0,chainId:'31337',nonce:'0',gasLimit:'21000',to:TO,value:'1',data:'0x',gasPrice:'1'};
async function record(f) {return f.vault.signAndRecord(f.account.id,{id:'capacity',nonceKey:'capacity',summary:{recipient:TO,chainId:'31337'}},secret=>signEvmTransaction(secret,tx));}

test('An unlock queued before immediate owner lock cannot publish plaintext afterward', async () => {
  const f = await vaultFixture();
  try {
    f.vault.lock(); const pending = f.vault.unlock(PASSWORD); f.vault.lock();
    await assert.rejects(pending, /LOCK_INTERRUPTED_OPERATION/);
    assert.equal(f.vault.status().locked, true);
    await f.vault.unlock(PASSWORD); assert.equal(f.vault.status().locked, false);
  } finally {f.close();}
});

test('Queued unlocks remain cancelled even after a later legitimate unlock', async () => {
  const f = await vaultFixture(), barrier = deferred();
  try {
    f.vault.lock(); const blocker = f.vault.serial(() => barrier.promise);
    await new Promise(r=>setImmediate(r));
    const old = f.vault.unlock(PASSWORD); const denied = assert.rejects(old, /LOCK_INTERRUPTED_OPERATION/);
    f.vault.lock(); const fresh = f.vault.unlock(PASSWORD);
    barrier.resolve(); await blocker; await denied; await fresh;
    assert.equal(f.vault.status().locked, false);
    assert.equal(f.vault.pendingOperations, 0);
  } finally {barrier.resolve(); f.close();}
});

test('Queued account mutation is cancelled at a lock boundary, not moved into the next session', async () => {
  const f = await vaultFixture(), barrier=deferred();
  try {
    const blocker=f.vault.serial(()=>barrier.promise); await new Promise(r=>setImmediate(r));
    const mutation=f.vault.addAccount({family:'evm',label:'must not exist',watchAddress:TO});
    const denied=assert.rejects(mutation,/LOCK_INTERRUPTED_OPERATION/);
    f.vault.lock(); const fresh=f.vault.unlock(PASSWORD); barrier.resolve();
    await blocker;await denied;await fresh;assert.equal(f.vault.publicAccounts().length,1);
  } finally {barrier.resolve();f.close();}
});

test('Queued signing is cancelled before the signer callback or disk write can execute', async () => {
  const f=await vaultFixture(),barrier=deferred();
  try {
    await f.backup();const before=f.store.read();let invoked=false;
    const blocker=f.vault.serial(()=>barrier.promise);await new Promise(r=>setImmediate(r));
    const pending=f.vault.signAndRecord(f.account.id,{id:'cancelled',nonceKey:'cancelled',summary:{}},()=>{invoked=true;return {};});
    const denied=assert.rejects(pending,/LOCK_INTERRUPTED_OPERATION/);f.vault.lock();barrier.resolve();await blocker;await denied;
    assert.equal(invoked,false);assert.equal(f.store.read(),before);
  }finally{barrier.resolve();f.close();}
});

test('Queue limit is bounded and all slots are released on cancellation',async()=>{
  const f=storeFixture(),v=new Vault(f.store),barrier=deferred();
  try{
    const blocker=v.serial(()=>barrier.promise);await new Promise(r=>setImmediate(r));
    const pending=Array.from({length:MAX_VAULT_PENDING_OPERATIONS-1},()=>v.serial(()=>{throw Error('MUST_NOT_RUN');}));
    const denied=pending.map(p=>assert.rejects(p,/LOCK_INTERRUPTED_OPERATION/));
    await assert.rejects(v.serial(()=>null),/VAULT_QUEUE_LIMIT/);
    v.lock();barrier.resolve();await blocker;await Promise.all(denied);
    assert.equal(v.pendingOperations,0);assert.equal(await v.serial(()=>42),42);
  }finally{barrier.resolve();v.lock();f.close();}
});

test('A capacity overflow cannot overwrite the last readable vault',async()=>{
  const f=await vaultFixture();
  try{
    await f.backup();const r=await record(f),before=f.store.read();
    await assert.rejects(f.vault.updateRecord(r.id,'broadcast-unknown',{note:'x'.repeat(MAX_VAULT_PLAINTEXT_BYTES)}),/VAULT_PLAINTEXT_SIZE_LIMIT/);
    assert.equal(f.vault.status().locked,true);assert.equal(f.store.read(),before);
    await f.vault.unlock(PASSWORD);assert.equal((await f.vault.journal())[0].state,'signed');
  }finally{f.close();}
});

test('A valid near-capacity encrypted vault can be reopened without data loss',async()=>{
  const f=await vaultFixture();
  try{
    await f.backup();const r=await record(f);
    const note='x'.repeat(MAX_VAULT_PLAINTEXT_BYTES-10000);
    await f.vault.updateRecord(r.id,'broadcast-unknown',{note});
    assert.ok(JSON.parse(f.store.read()).ciphertext.length<=MAX_VAULT_PLAINTEXT_BYTES*2);
    f.vault.lock();await f.vault.unlock(PASSWORD);assert.equal((await f.vault.journal())[0].report.note,note);
  }finally{f.close();}
});
