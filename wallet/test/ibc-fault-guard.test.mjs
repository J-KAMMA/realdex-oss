import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {assertStoreFailure} from '../../integration/ibc/save-failure.mjs';
import {vaultFixture, PASSWORD} from './fixtures.mjs';
function fixture() {
 let locked=false, sent=0, unlocks=0;
 const store={write(){return 'original';}},original=store.write;
 const vault={status:()=>({locked})};
 const options={store,vault,submissions:()=>sent,unlock:async()=>{unlocks++;locked=false;}};
 options.operation=async()=>{try{store.write('not persisted');}catch(e){locked=true;throw e;}};
 return {options,store,original,get locked(){return locked;},get unlocks(){return unlocks;},
  lock(){locked=true;},send(){sent++;}};
}
test('Exact injected failure requires one reached write, no send, lock and writer restoration',async()=>{
 const f=fixture(),r=await assertStoreFailure(f.options);
 assert.deepEqual(r,{writes:1,submissions:0,writerRestored:true});assert.equal(f.store.write,f.original);assert.equal(f.locked,false);assert.equal(f.unlocks,1);
});
test('Owner HTTP error serialization does not require the same Error object',async()=>{
 const f=fixture();f.options.operation=async()=>{try{f.store.write();}catch(e){f.lock();throw new Error(e.message);}};
 assert.equal((await assertStoreFailure(f.options)).writes,1);
});
test('An unrelated early RPC failure remains the primary error; no ALREADY_UNLOCKED cleanup',async()=>{
 const f=fixture(),rpc=Error('COSMOS_RPC_HTTP_ERROR');f.options.operation=async()=>{throw rpc;};
 await assert.rejects(assertStoreFailure(f.options),e=>e===rpc);
 assert.equal(f.unlocks,0);assert.equal(f.store.write,f.original);
});
test('A matching error name without reaching persistence is NOT the expected failure',async()=>{
 const f=fixture();f.options.operation=async()=>{throw Error('TEST_SAVE_FAILURE');};
 await assert.rejects(assertStoreFailure(f.options),/EXACTLY_ONE_STORE_WRITE/);assert.equal(f.unlocks,0);
});
test('An operation that resolves instead of failing cannot pass',async()=>{
 const f=fixture();f.options.operation=async()=>{};await assert.rejects(assertStoreFailure(f.options),/EXPECTED_INJECTED_SAVE_FAILURE/);assert.equal(f.store.write,f.original);
});
test('Swallowing the injected failure cannot pass',async()=>{
 const f=fixture();f.options.operation=async()=>{try{f.store.write();}catch{f.lock();}};
 await assert.rejects(assertStoreFailure(f.options),/EXPECTED_INJECTED_SAVE_FAILURE/);assert.equal(f.unlocks,1);
});
test('Two reached writes cannot pass the one-failure assertion',async()=>{
 const f=fixture();f.options.operation=async()=>{try{f.store.write();}catch{}try{f.store.write();}catch(e){f.lock();throw e;}};
 await assert.rejects(assertStoreFailure(f.options),/EXACTLY_ONE_STORE_WRITE/);assert.equal(f.store.write,f.original);
});
test('Hidden submission after a save failure cannot pass',async()=>{
 const f=fixture();f.options.operation=async()=>{try{f.store.write();}catch(e){f.send();f.lock();throw e;}};
 await assert.rejects(assertStoreFailure(f.options),/MUST_NOT_SUBMIT/);
});
test('Save failure without locking the Vault cannot pass',async()=>{
 const f=fixture();f.options.operation=async()=>f.store.write();await assert.rejects(assertStoreFailure(f.options),/MUST_LOCK/);assert.equal(f.unlocks,0);
});
test('Cleanup failure is retained even after expected injected failure',async()=>{
 const f=fixture(),cleanup=Error('TEST_UNLOCK_FAILURE');f.options.unlock=async()=>{throw cleanup;};
 await assert.rejects(assertStoreFailure(f.options),e=>e===cleanup);assert.equal(f.store.write,f.original);
});
test('Primary and cleanup failures are both preserved with primary first',async()=>{
 const f=fixture(),primary=Error('COSMOS_RPC_HTTP_ERROR'),cleanup=Error('TEST_UNLOCK_FAILURE');
 f.options.operation=async()=>{f.lock();throw primary;};f.options.unlock=async()=>{throw cleanup;};
 await assert.rejects(assertStoreFailure(f.options),e=>e instanceof AggregateError&&e.message==='IBC_FAULT_PRIMARY_AND_CLEANUP'&&e.errors[0]===primary&&e.errors[1]===cleanup);
 assert.equal(f.store.write,f.original);
});
test('Even a thrown undefined value remains a failure rather than a false pass',async()=>{
 const f=fixture();f.options.operation=async()=>{throw undefined;};let rejected=false;
 try{await assertStoreFailure(f.options);}catch(e){rejected=true;assert.equal(e,undefined);}assert.equal(rejected,true);assert.equal(f.store.write,f.original);
});
test('A prelocked Vault is not unlocked or mutated by fault setup',async()=>{
 const f=fixture();f.lock();await assert.rejects(assertStoreFailure(f.options),/REQUIRES_UNLOCKED/);assert.equal(f.store.write,f.original);assert.equal(f.unlocks,0);
});
for(const key of ['operation','submissions','unlock'])test('Missing callback rejected before injection: '+key,async()=>{
 const f=fixture();delete f.options[key];await assert.rejects(assertStoreFailure(f.options),/CALLBACK_REQUIRED/);assert.equal(f.store.write,f.original);
});
test('Actual encrypted Vault save failure restores original disk and rejects uncommitted account',async t=>{
 const f=await vaultFixture();t.after(()=>f.close());const before=fs.readFileSync(f.store.file??f.directory+'/vault.json');
 let sends=0;const initial=(await f.vault.publicAccounts()).length;
 await assertStoreFailure({store:f.store,vault:f.vault,operation:()=>f.vault.addAccount({family:'cosmos',label:'Disposable failed fixture',secretHex:'45'.repeat(32)}),submissions:()=>sends,unlock:()=>f.vault.unlock(PASSWORD)});
 assert.deepEqual(fs.readFileSync(f.store.file??f.directory+'/vault.json'),before);assert.equal((await f.vault.publicAccounts()).length,initial);assert.equal(sends,0);
});
test('Cleanup must not hide an additional submission',async()=>{
 const f=fixture(),unlock=f.options.unlock;f.options.unlock=async()=>{await unlock();f.send();};
 await assert.rejects(assertStoreFailure(f.options),/CLEANUP_MUST_NOT_SUBMIT/);
});
