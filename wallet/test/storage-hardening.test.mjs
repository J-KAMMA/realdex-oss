import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {storeFixture, vaultFixture, PASSWORD} from './fixtures.mjs';
import {PrivateStore} from '../lib/storage.mjs';

function fault(name, predicate, fn) {
  const original=fs[name];
  fs[name]=function(...args){if(predicate(...args))throw Error('INJECTED_IO_FAILURE');return original.apply(this,args);};
  try {return fn();} finally {fs[name]=original;}
}
function temporaryFiles(store){return fs.readdirSync(store.directory).filter(n=>n.startsWith('.write-'));}
for(const stage of ['writeFileSync','fsyncSync','renameSync']) {
  test(`Atomic ${stage} fault preserves previous vault and removes temporary files`,()=>{
    const f=storeFixture();
    try {
      f.store.write('previous',{create:true});
      assert.throws(()=>fault(stage,()=>true,()=>f.store.write('replacement')),/INJECTED_IO_FAILURE/);
      assert.equal(f.store.read(),'previous');assert.deepEqual(temporaryFiles(f.store),[]);
    }finally{f.close();}
  });
}
test('Directory fsync failure reports uncertainty even when rename completed',()=>{
  const f=storeFixture();
  try {
    f.store.write('previous',{create:true});
    assert.throws(()=>fault('fsyncSync',fd=>fs.fstatSync(fd).isDirectory(),()=>f.store.write('replacement')),/INJECTED_IO_FAILURE/);
    assert.equal(f.store.read(),'replacement');assert.deepEqual(temporaryFiles(f.store),[]);
  }finally{f.close();}
});
test('Exclusive creation failure cannot leave a temporary file or overwrite another vault',()=>{
  const f=storeFixture();
  try{
    assert.throws(()=>fault('linkSync',()=>true,()=>f.store.write('new',{create:true})),/INJECTED_IO_FAILURE/);
    assert.equal(f.store.exists(),false);assert.deepEqual(temporaryFiles(f.store),[]);
    f.store.write('first',{create:true});assert.throws(()=>f.store.write('second',{create:true}),/VAULT_ALREADY_EXISTS/);assert.equal(f.store.read(),'first');
  }finally{f.close();}
});
test('Lock initialization fsync failure removes only the newly created lock',()=>{
  const f=storeFixture();const directory=f.directory;f.store.close();
  try{
    assert.throws(()=>fault('fsyncSync',()=>true,()=>new PrivateStore(directory)),/VAULT_IN_USE_OR_STALE_LOCK/);
    assert.equal(fs.existsSync(path.join(directory,'writer.lock')),false);
    const next=new PrivateStore(directory);next.close();
  }finally{f.close();}
});
test('Replacing writer.lock blocks reads/writes and close does not remove replacement lock',()=>{
  const f=storeFixture();
  try{
    f.store.write('original',{create:true});
    fs.renameSync(f.store.lockFile,f.store.lockFile+'.old');fs.writeFileSync(f.store.lockFile,'replacement',{mode:0o600});
    assert.throws(()=>f.store.write('wrong'),/STORE_LOCK_OWNERSHIP_LOST/);
    assert.throws(()=>f.store.read(),/STORE_LOCK_OWNERSHIP_LOST/);
    f.store.close();assert.equal(fs.readFileSync(f.store.lockFile,'utf8'),'replacement');
  }finally{f.close();}
});
test('Deleted writer lock is not automatically recreated by a live store',()=>{
  const f=storeFixture();
  try{fs.unlinkSync(f.store.lockFile);assert.throws(()=>f.store.write('wrong'),/STORE_LOCK_OWNERSHIP_LOST/);assert.equal(fs.existsSync(f.store.lockFile),false);}
  finally{f.close();}
});
test('Vault permissions are enforced for updates as well as reads',()=>{
  const f=storeFixture();
  try{
    f.store.write('previous',{create:true});
    if(process.platform!=='win32'){
      fs.chmodSync(f.store.file,0o644);assert.throws(()=>f.store.write('changed'),/VAULT_PERMISSIONS_UNSAFE/);
      assert.equal(fs.readFileSync(f.store.file,'utf8'),'previous');fs.chmodSync(f.store.file,0o600);
    }
  }finally{f.close();}
});
test('Lost lock during signing save returns no successful vault mutation',async()=>{
  const f=await vaultFixture();
  try{
    const before=fs.readFileSync(f.store.file,'utf8');fs.renameSync(f.store.lockFile,f.store.lockFile+'.old');
    await assert.rejects(f.vault.addAccount({family:'icp',label:'not persisted'}),/STORE_LOCK_OWNERSHIP_LOST/);
    assert.equal(f.vault.status().locked,true);assert.equal(fs.readFileSync(f.store.file,'utf8'),before);
  }finally{f.close();}
});
