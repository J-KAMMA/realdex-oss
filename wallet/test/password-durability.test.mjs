import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {vaultFixture,PASSWORD,TO} from './fixtures.mjs';
const NEXT='Replacement public test password - not for funds';
for(const committed of [false,true]) {
  test(`Password replacement ${committed?'post-rename directory fsync':'pre-write'} failure locks memory; reopens actual durable version`,async()=>{
    const f=await vaultFixture();
    const write=f.store.write.bind(f.store);let calls=0;
    try {
      const original=f.store.read(),heldKey=f.vault.key,heldAccount=f.vault.account(f.account.id);
      f.store.write=(data,opts)=>{calls++;if(committed)write(data,opts);throw Error('INJECTED_PASSWORD_DURABILITY_FAILURE');};
      await assert.rejects(f.vault.changePassword(PASSWORD,NEXT),/INJECTED_PASSWORD_DURABILITY_FAILURE/);
      f.store.write=write;
      assert.equal(calls,1);assert.equal(f.vault.status().locked,true);
      assert.equal(f.vault.key,null);assert.equal(f.vault.data,null);
      assert.ok(heldKey.every(b=>b===0));assert.equal(heldAccount.secretHex,null);
      if(committed)assert.notEqual(f.store.read(),original);else assert.equal(f.store.read(),original);
      await f.vault.unlock(committed?NEXT:PASSWORD);
      assert.equal(f.vault.publicAccounts()[0].address,f.account.address);
      assert.equal(f.vault.publicAccounts().length,1);
    }finally{f.store.write=write;f.close();}
  });
}
test('Actual directory fsync failure during password replacement locks and does not erase committed ciphertext',async()=>{
  const f=await vaultFixture(),sync=fs.fsyncSync;let intercepted=0;
  try {
    fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory()){intercepted++;throw Error('INJECTED_DIRECTORY_DURABILITY_FAILURE');}return sync(fd);};
    await assert.rejects(f.vault.changePassword(PASSWORD,NEXT),/INJECTED_DIRECTORY_DURABILITY_FAILURE/);
    fs.fsyncSync=sync;assert.equal(intercepted,1);assert.equal(f.vault.status().locked,true);
    await f.vault.unlock(NEXT);assert.equal(f.vault.publicAccounts()[0].address,f.account.address);
  }finally{fs.fsyncSync=sync;f.close();}
});
test('Queued mutation cannot run after password persistence becomes uncertain',async()=>{
  const f=await vaultFixture(),write=f.store.write.bind(f.store);
  try {
    f.store.write=()=>{throw Error('INJECTED_PASSWORD_DURABILITY_FAILURE');};
    const change=f.vault.changePassword(PASSWORD,NEXT);
    const queued=f.vault.addAccount({family:'evm',label:'must not be added',watchAddress:TO});
    const rejected=assert.rejects(queued,/LOCK_INTERRUPTED_OPERATION/);
    await assert.rejects(change,/INJECTED_PASSWORD_DURABILITY_FAILURE/);await rejected;
    assert.equal(f.vault.status().locked,true);f.store.write=write;
    await f.vault.unlock(PASSWORD);assert.equal(f.vault.publicAccounts().length,1);
  }finally{f.store.write=write;f.close();}
});
