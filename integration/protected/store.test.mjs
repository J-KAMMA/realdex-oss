import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync,spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';import {validateStorageProtection,requireStorageProtection,PROTECTION_SCHEME} from '../../wallet/protected/binding.mjs';
const ROOT=path.resolve(import.meta.dirname,'../..'),LAUNCH=path.join(import.meta.dirname,'test-launch.py');
const IMPORT=`import fs from 'node:fs';import assert from 'node:assert/strict';import{CheckpointLeaseStore}from'./wallet/protected/store.mjs';import{Vault}from'./wallet/lib/vault.mjs';const home=process.argv[1],witness=process.argv[2];`;
const PASS='Disposable checkpoint passphrase, not a user secret';
function pair(t){const a=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-vault-')),b=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-witness-'));t.after(()=>{fs.rmSync(a,{recursive:true,force:true});fs.rmSync(b,{recursive:true,force:true});});return {a,b};}
function run(p,code,{enroll=false,timeout=20000}={}){return spawnSync('python3',['-I','-S',LAUNCH,p.a,p.b,enroll?'yes':'no','probe',IMPORT+code],{cwd:ROOT,encoding:'utf8',timeout,maxBuffer:1048576,shell:false});}
function success(r){assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):null;}
const init=p=>success(run(p,`const s=new CheckpointLeaseStore(home,witness);s.write('old',{create:true});s.close();`,{enroll:true}));
test('Storage binding is strict and cannot be used without the paired store',()=>{
 const p={scheme:PROTECTION_SCHEME,pairId:'a'.repeat(64)};
 assert.deepEqual(validateStorageProtection(p),p);requireStorageProtection({storageProtection:p},{protection:p});requireStorageProtection({},{});
 for(const [payload,store] of [[{storageProtection:p},{}],[{}, {protection:p}],[{storageProtection:p},{protection:{...p,pairId:'b'.repeat(64)}}]])
  assert.throws(()=>requireStorageProtection(payload,store),/PROTECTION/);
 for(const v of [{...p,other:1},{...p,pairId:'z'.repeat(64)},{...p,scheme:'old-INJ13'},null])assert.throws(()=>validateStorageProtection(v));
});
test('New pair is explicit, two permanent locks and fresh checkpoint only',t=>{
 const p=pair(t);const x=success(run(p,`const s=new CheckpointLeaseStore(home,witness);console.log(JSON.stringify(s.info()));s.close();`,{enroll:true}));
 assert.equal(x.generation,'0');assert.equal(x.jointRollbackDetected,false);
 assert.ok(fs.existsSync(path.join(p.a,'writer.lock'))&&fs.existsSync(path.join(p.b,'writer.lock')));
 assert.notEqual(run(p,``,{enroll:true}).status,0);
});
for(const stage of ['staged','intent','renamed','vault-durable','checkpoint-durable']){
 test('SIGKILL during an update at '+stage+' recovers only the recorded generation',t=>{
  const p=pair(t);init(p);const ia=fs.statSync(path.join(p.a,'writer.lock')).ino,ib=fs.statSync(path.join(p.b,'writer.lock')).ino;
  const r=run(p,`const s=new CheckpointLeaseStore(home,witness,{onBoundary:x=>{if(x===${JSON.stringify(stage)})process.kill(process.pid,'SIGKILL');}});s.write('new');`);
  assert.equal(r.signal,'SIGKILL');const v=success(run(p,`const s=new CheckpointLeaseStore(home,witness);console.log(JSON.stringify({data:s.read(),info:s.info()}));s.close();`));
  assert.equal(v.data,stage==='staged'?'old':'new');assert.equal(v.info.generation,stage==='staged'?'1':'2');
  assert.equal(fs.statSync(path.join(p.a,'writer.lock')).ino,ia);assert.equal(fs.statSync(path.join(p.b,'writer.lock')).ino,ib);
  assert.equal(fs.existsSync(path.join(p.a,'pending-ciphertext')),false);
 });
 test('A storage exception at '+stage+' poisons this process until restart',t=>{
  const p=pair(t);init(p);
  success(run(p,`const s=new CheckpointLeaseStore(home,witness,{onBoundary:x=>{if(x===${JSON.stringify(stage)})throw Error('TEST_IO');}});
assert.throws(()=>s.write('new'),/TEST_IO/);assert.throws(()=>s.read(),/RESTART_REQUIRED/);s.close();`));
  success(run(p,`const s=new CheckpointLeaseStore(home,witness);assert.equal(s.read(),${JSON.stringify(stage==='staged'?'old':'new')});s.close();`));
 });
 test('First Vault body creation interrupted at '+stage+' never resets an acknowledged checkpoint',t=>{
  const p=pair(t);const r=run(p,`const s=new CheckpointLeaseStore(home,witness,{onBoundary:x=>{if(x===${JSON.stringify(stage)})process.kill(process.pid,'SIGKILL');}});s.write('first',{create:true});`,{enroll:true});
  assert.equal(r.signal,'SIGKILL');
  success(run(p,`const s=new CheckpointLeaseStore(home,witness);assert.equal(s.exists(),${stage!=='staged'});s.close();`));
 });
}
test('Unilateral Vault rollback is rejected before it can be decrypted',t=>{
 const p=pair(t);init(p);const old=fs.readFileSync(path.join(p.a,'vault.json'));
 success(run(p,`const s=new CheckpointLeaseStore(home,witness);s.write('new');s.close();`));fs.writeFileSync(path.join(p.a,'vault.json'),old);
 const r=run(p,`new CheckpointLeaseStore(home,witness);`);assert.match(r.stderr,/CP_CIPHERTEXT_MISMATCH/);
});
test('Unilateral checkpoint rollback is rejected, never applied to the newer Vault',t=>{
 const p=pair(t);init(p);const old=fs.readFileSync(path.join(p.b,'checkpoint.json'));
 success(run(p,`const s=new CheckpointLeaseStore(home,witness);s.write('new');s.close();`));fs.writeFileSync(path.join(p.b,'checkpoint.json'),old);
 assert.match(run(p,`new CheckpointLeaseStore(home,witness);`).stderr,/CP_CIPHERTEXT_MISMATCH/);assert.equal(fs.readFileSync(path.join(p.a,'vault.json'),'utf8'),'new');
});
test('Joint rollback limitation is explicit: local hashes cannot authenticate an independent latest state',t=>{
 const p=pair(t);init(p);const old=fs.readFileSync(path.join(p.b,'checkpoint.json'));
 success(run(p,`const s=new CheckpointLeaseStore(home,witness);s.write('new');s.close();`));fs.writeFileSync(path.join(p.b,'checkpoint.json'),old);fs.writeFileSync(path.join(p.a,'vault.json'),'old');
 const r=success(run(p,`const s=new CheckpointLeaseStore(home,witness);console.log(JSON.stringify(s.info()));s.close();`));
 assert.equal(r.generation,'1');assert.equal(r.jointRollbackDetected,false);
});
for(const kind of ['missing','truncated','duplicate-field','wrong-pair','unsafe-mode','symlink','hardlink']){
 test('Corrupt/unsafe checkpoint fails closed: '+kind,t=>{
  const p=pair(t);init(p);const file=path.join(p.b,'checkpoint.json');
  if(kind==='missing')fs.unlinkSync(file);
  if(kind==='truncated')fs.writeFileSync(file,'{');
  if(kind==='duplicate-field')fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('"bytes":3','"bytes":3,"bytes":3'));
  if(kind==='wrong-pair'){const r=JSON.parse(fs.readFileSync(file));r.pairId='a'.repeat(64);fs.writeFileSync(file,JSON.stringify(r));}
  if(kind==='unsafe-mode')fs.chmodSync(file,0o644);
  if(kind==='symlink'){fs.renameSync(file,path.join(p.b,'other'));fs.symlinkSync('other',file);}
  if(kind==='hardlink')fs.linkSync(file,path.join(p.b,'other'));
  assert.notEqual(run(p,`new CheckpointLeaseStore(home,witness);`).status,0);assert.equal(fs.readFileSync(path.join(p.a,'vault.json'),'utf8'),'old');
 });
}
for(const mode of ['missing-stage','changed-stage','changed-main']){
 test('Pending commit refuses unrecorded input '+mode,t=>{
  const p=pair(t);init(p);assert.equal(run(p,`const s=new CheckpointLeaseStore(home,witness,{onBoundary:x=>{if(x==='intent')process.kill(process.pid,'SIGKILL');}});s.write('new');`).signal,'SIGKILL');
  const target=path.join(p.a,mode==='changed-main'?'vault.json':'pending-ciphertext');
  if(mode==='missing-stage')fs.unlinkSync(target);else fs.writeFileSync(target,'unexpected');
  assert.notEqual(run(p,`new CheckpointLeaseStore(home,witness);`).status,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.b,'checkpoint.json'))).phase,'pending');
 });
}
test('Missing body can restore the exact current bytes only; no generation or hash changes',t=>{
 const p=pair(t);init(p);success(run(p,`const s=new CheckpointLeaseStore(home,witness);s.write('new');s.close();`));
 fs.unlinkSync(path.join(p.a,'vault.json'));const cp=fs.readFileSync(path.join(p.b,'checkpoint.json'));
 success(run(p,`const s=new CheckpointLeaseStore(home,witness);assert.equal(s.exists(),true);assert.throws(()=>s.write('fresh',{create:true}));assert.throws(()=>s.restoreExact('old'),/BACKUP_NOT_CURRENT/);s.restoreExact('new');assert.equal(s.read(),'new');assert.throws(()=>s.restoreExact('new'),/MISSING_BODY/);s.close();`));
 assert.deepEqual(fs.readFileSync(path.join(p.b,'checkpoint.json')),cp);
});
test('Multiple in-process Vaults cannot reuse a session after the other writes',t=>{
 const p=pair(t);success(run(p,`const s=new CheckpointLeaseStore(home,witness),a=new Vault(s),b=new Vault(s);await a.create(${JSON.stringify(PASS)});await b.unlock(${JSON.stringify(PASS)});await a.addAccount({family:'evm',label:'a',watchAddress:'0x1111111111111111111111111111111111111111'});assert.throws(()=>b.check(),/STALE_SESSION/);assert.equal(b.key,null);a.lock();s.close();`,{enroll:true}));
});
test('Protected backup verification returns the CURRENT ciphertext, second verification does not write',t=>{
 const p=pair(t);success(run(p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.create(${JSON.stringify(PASS)});await v.addAccount({family:'evm',label:'a',watchAddress:'0x1111111111111111111111111111111111111111'});const b=await v.backup(),r=await v.verifyBackup(b.encrypted,${JSON.stringify(PASS)});assert.notEqual(b.encrypted,r.encrypted);assert.equal(r.encrypted,s.read());const g=s.info().generation;await v.verifyBackup(r.encrypted,${JSON.stringify(PASS)});assert.equal(s.info().generation,g);await assert.rejects(v.verifyBackup(b.encrypted,${JSON.stringify(PASS)}),/CP_BACKUP_NOT_CURRENT/);v.lock();s.close();`,{enroll:true}));
});
test('Copied protected ciphertext refuses unlock or restore without the paired protection',t=>{
 const p=pair(t);success(run(p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.create(${JSON.stringify(PASS)});const encrypted=s.read();v.lock();s.close();const plain={read:()=>encrypted,exists:()=>true,write:()=>{throw Error('WRITE_FORBIDDEN')}};const x=new Vault(plain);await assert.rejects(x.unlock(${JSON.stringify(PASS)}),/PROTECTION_REQUIRED/);assert.equal(x.key,null);plain.exists=()=>false;await assert.rejects(new Vault(plain).restore(encrypted,${JSON.stringify(PASS)}),/PROTECTION_REQUIRED/);`,{enroll:true}));
});
test('Protected recovery authenticates password, restores only current ciphertext and preserves lock state',t=>{
 const p=pair(t);success(run(p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.create(${JSON.stringify(PASS)});const encrypted=s.read();v.lock();fs.unlinkSync(s.file);await assert.rejects(v.restore(encrypted,'incorrect passphrase which is long'),/AUTHENTICATION_FAILED/);assert.equal(fs.existsSync(s.file),false);await v.restore(encrypted,${JSON.stringify(PASS)});assert.equal(v.key,null);await v.unlock(${JSON.stringify(PASS)});assert.equal(v.data.storageProtection.pairId,s.protection.pairId);v.lock();s.close();`,{enroll:true}));
});
test('Malformed protection payload or a different pair is rejected before key becomes live',t=>{
 const p=pair(t);success(run(p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.create(${JSON.stringify(PASS)});const old=s.read();v.data.storageProtection.pairId='b'.repeat(64);assert.throws(()=>v.check(),/PROTECTION_MISMATCH/);assert.equal(v.key,null);assert.equal(s.read(),old);s.close();`,{enroll:true}));
});
for(const stage of ['staged','intent','checkpoint-durable']){
 test('Vault save failure locks and requires restart at '+stage,t=>{
  const p=pair(t);success(run(p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.create(${JSON.stringify(PASS)});s.onBoundary=x=>{if(x===${JSON.stringify(stage)})throw Error('CP_TEST_FAILURE')};await assert.rejects(v.addAccount({family:'evm',label:'a',watchAddress:'0x1111111111111111111111111111111111111111'}),/CP_TEST_FAILURE/);assert.equal(v.key,null);assert.equal(v.status().protectedStorage.failed,true);s.close();`,{enroll:true}));
  success(run(p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.unlock(${JSON.stringify(PASS)});assert.equal(v.publicAccounts().length,${stage==='staged'?0:1});v.lock();s.close();`));
 });
}
test('Live writer blocks a second process on the checkpoint AND vault pair',t=>{
 const p=pair(t);init(p);
 success(run(p,`import{spawnSync}from'node:child_process';const s=new CheckpointLeaseStore(home,witness);const r=spawnSync('python3',['-I','-S',${JSON.stringify(LAUNCH)},home,witness,'no','probe',''],{encoding:'utf8',timeout:5000});assert.notEqual(r.status,0);assert.match(r.stderr,/CP_BUSY/);s.close();`));
});
test('Normal legacy storage remains blocked by permanent writer.lock after protected shutdown',t=>{
 const p=pair(t);init(p);success(run(p,`import{PrivateStore}from'./wallet/lib/storage.mjs';const s=new CheckpointLeaseStore(home,witness);s.close();assert.throws(()=>new PrivateStore(home),/VAULT_IN_USE_OR_STALE_LOCK/);assert.ok(fs.existsSync(home+'/writer.lock'));`));
});
test('Kernel lease loss is detected before another read or write',t=>{
 const p=pair(t);init(p);success(run(p,`import{spawnSync}from'node:child_process';const s=new CheckpointLeaseStore(home,witness);const r=spawnSync('python3',['-I','-S','-c','import fcntl;fcntl.flock(3,fcntl.LOCK_UN)'],{stdio:['ignore','ignore','ignore',s.parts[0].fd]});assert.equal(r.status,0);assert.throws(()=>s.read(),/LEASE_LOST/);s.close();`));
});
test('Session refuses outside changes to a ciphertext with no new checkpoint',t=>{
 const p=pair(t);init(p);success(run(p,`const s=new CheckpointLeaseStore(home,witness);const t=s.sessionToken();fs.writeFileSync(s.file,'changed');assert.throws(()=>s.assertSession(t),/CIPHERTEXT_MISMATCH/);s.close();`));
});
test('Enrolling an already used directory, aliased pair or symlink parent is forbidden',t=>{
 const p=pair(t);fs.writeFileSync(path.join(p.a,'existing'),'not ours');assert.notEqual(run(p,'',{enroll:true}).status,0);
 const same={a:p.a,b:p.a};assert.notEqual(run(same,'',{enroll:true}).status,0);
});
test('Explicit launcher has no implicit/default directory or arbitrary host option',()=>{
 for(const args of [[],['--directory','/tmp'],['--exec','anything']]){
  const r=spawnSync('python3',['-I','-S','wallet/protected/launch.py',...args],{cwd:ROOT,encoding:'utf8',timeout:5000});assert.notEqual(r.status,0);
 }
});
test('Owner page carries a protection-specific warning and current backup handling',()=>{
 const html=fs.readFileSync(path.join(ROOT,'wallet/public/index.html'),'utf8'),js=fs.readFileSync(path.join(ROOT,'wallet/public/app.mjs'),'utf8');
 assert.match(html,/id="protectedStorage"/);assert.match(js,/verified.protectedStorage/);assert.match(js,/verified.encrypted/);assert.match(js,/jointRollbackDetected|両方を巻き戻す/);
});

test('Protected password change keeps binding and rejects the stale prior backup',t=>{
 const p=pair(t);success(run(p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.create(${JSON.stringify(PASS)});const old=s.read();await v.changePassword(${JSON.stringify(PASS)},'New disposable passphrase, not a user key');assert.equal(v.key,null);assert.throws(()=>s.assertExactBackup(old),/BACKUP_NOT_CURRENT/);await v.unlock('New disposable passphrase, not a user key');assert.equal(v.data.storageProtection.pairId,s.protection.pairId);v.lock();s.close();`,{enroll:true}));
});
test('Checkpoint deletion during a live session locks rather than recreating it',t=>{
 const p=pair(t);success(run(p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.create(${JSON.stringify(PASS)});fs.unlinkSync(s.cp);assert.throws(()=>v.check(),/CHECKPOINT_MISSING/);assert.equal(v.key,null);assert.equal(v.status().protectedStorage.failed,true);assert.equal(fs.existsSync(s.cp),false);s.close();`,{enroll:true}));
});
test('No protected enrollment over a copied unprotected Vault, even with a valid password',t=>{
 const p=pair(t);fs.writeFileSync(path.join(p.a,'vault.json'),'{"schema":"existing"}',{mode:0o600});
 const r=run(p,'',{enroll:true});assert.match(r.stderr,/ENROLL_EMPTY_REQUIRED/);assert.equal(fs.existsSync(path.join(p.b,'checkpoint.json')),false);
});
test('Temporary atomic files are discarded, never adopted as latest ciphertext',t=>{
 const p=pair(t);init(p);const name='.cp-write-'+'a'.repeat(32);
 fs.writeFileSync(path.join(p.a,name),'uncommitted',{mode:0o600});
 success(run(p,`const s=new CheckpointLeaseStore(home,witness);assert.equal(s.read(),'old');s.close();`));
 assert.equal(fs.existsSync(path.join(p.a,name)),false);
});
