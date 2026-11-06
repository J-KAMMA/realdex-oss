import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {PipeDriver} from '../drivers.mjs';import {parseKernelLock,KernelLeaseStore} from '../kernel-store.mjs';
const launcher=fileURLToPath(new URL('../kernel-lease.py',import.meta.url));
const root=path.resolve(import.meta.dirname,'../../..');
function home(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-e2e08-vault-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
const child=p=>new PipeDriver({command:'python3',args:['-I',launcher,'--directory',p],timeoutMs:10000,env:{REALDEX_E2E08_CHILD:'disposable-only'}});
async function close(c){if(!c.exit&&!c.failure)await c.send('stop',{});try{await c.close();}catch(e){assert.equal(e.message,'E2E_CHILD_EXIT');}}
async function rejected(p,pattern){const c=child(p);try{await assert.rejects(c.send('probe',{}),pattern);}finally{await close(c);}}
const legacy=p=>spawnSync(process.execPath,['--input-type=module','-e',`import{PrivateStore}from'./wallet/lib/storage.mjs';try{const s=new PrivateStore(process.argv[1]);s.close();process.exit(2)}catch(e){if(e.message!=='VAULT_IN_USE_OR_STALE_LOCK')process.exit(3)}`,p],{cwd:root,encoding:'utf8',timeout:5000});

test('The fdinfo parser requires this PID, inode, exclusive flock and full-file interval',()=>{
 assert.equal(parseKernelLock('pos:\t0\nlock:\t1: FLOCK ADVISORY WRITE 15 00:1c:27 0 EOF\n',{pid:15,ino:27}),true);
});
for(const row of ['', 'lock: 1: POSIX ADVISORY WRITE 15 00:1c:27 0 EOF','lock: 1: FLOCK ADVISORY READ 15 00:1c:27 0 EOF','lock: 1: FLOCK ADVISORY WRITE 16 00:1c:27 0 EOF','lock: 1: FLOCK ADVISORY WRITE 15 00:1c:28 0 EOF','lock: 1: FLOCK ADVISORY WRITE 15 00:1c:27 1 EOF','lock: 1: FLOCK ADVISORY WRITE 15 00:1c:27 0 1024','lock: 1: FLOCK ADVISORY WRITE 15 00:1c:27 0 EOF\nlock: 2: FLOCK ADVISORY WRITE 15 00:1c:27 0 EOF'])
 test('Wrong or ambiguous kernel lease is rejected: '+row.slice(0,60),()=>assert.throws(()=>parseKernelLock(row,{pid:15,ino:27}),/LEASE_NOT_HELD/));
test('Oversized fdinfo cannot stand in for a kernel observation',()=>assert.throws(()=>parseKernelLock('x'.repeat(16385),{pid:1,ino:1}),/FDINFO_LIMIT/));
test('Direct candidate use without explicit disposable launcher is refused',()=>assert.throws(()=>new KernelLeaseStore('/tmp/realdex-e2e08-vault-fake',4),/EXPLICIT_TEST_MODE/));
test('Launcher refuses missing explicit test environment',t=>{const p=home(t),r=spawnSync('python3',['-I',launcher,'--directory',p],{encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH}});assert.equal(r.status,1);assert.match(r.stdout,/EXPLICIT_TEST_MODE/);assert.deepEqual(fs.readdirSync(p),[]);});
test('No lease API takes a PID or a force-unlock option',t=>{const p=home(t),r=spawnSync('python3',['-I',launcher,'--directory',p,'--force'],{encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH,REALDEX_E2E08_CHILD:'disposable-only'}});assert.equal(r.status,2);assert.deepEqual(fs.readdirSync(p),[]);});
test('Existing Vault without a lease marker is not automatically migrated',async t=>{const p=home(t);fs.writeFileSync(path.join(p,'vault.json'),'do not migrate',{mode:0o600});await rejected(p,/NEW_DIRECTORY_REQUIRED/);assert.deepEqual(fs.readdirSync(p),['vault.json']);});
for(const content of ['12345','', 'other marker\n','x'.repeat(129)])test('Legacy, partial or corrupt marker is preserved: '+JSON.stringify(content.slice(0,12)),async t=>{
 const p=home(t),lock=path.join(p,'writer.lock');fs.writeFileSync(lock,content,{mode:0o600});const ino=fs.statSync(lock).ino;
 await rejected(p,/LOCK_FORMAT/);assert.equal(fs.readFileSync(lock,'utf8'),content);assert.equal(fs.statSync(lock).ino,ino);
});
test('Symlinked lease cannot redirect ownership',async t=>{const p=home(t),other=path.join(p,'target');fs.writeFileSync(other,'unchanged',{mode:0o600});fs.symlinkSync(other,path.join(p,'writer.lock'));await rejected(p,/LAUNCH_FAILED/);assert.equal(fs.readFileSync(other,'utf8'),'unchanged');});
test('Hard-linked lease is rejected without altering either path',async t=>{const p=home(t),f=path.join(p,'writer.lock');fs.writeFileSync(f,'realdex.experimental.kernel-lease.v1\n',{mode:0o600});fs.linkSync(f,path.join(p,'alias'));await rejected(p,/UNSAFE_FILE/);assert.equal(fs.statSync(f).nlink,2);});
test('Directory permissions cannot be bypassed by a valid marker',async t=>{const p=home(t);fs.chmodSync(p,0o755);await rejected(p,/UNSAFE_FILE/);assert.deepEqual(fs.readdirSync(p),[]);});
test('FIFO lock fails without blocking',async t=>{const p=home(t);const r=spawnSync('mkfifo',['-m','600',path.join(p,'writer.lock')]);assert.equal(r.status,0);await rejected(p,/UNSAFE_FILE/);});
test('Normal close retains the same lock inode and permits a new exclusive owner',async t=>{
 const p=home(t),c=child(p);let first;
 try{first=await c.send('probe',{});await c.send('probe-write',{data:'ciphertext fixture',create:true});}finally{await close(c);}
 const ino=fs.statSync(path.join(p,'writer.lock')).ino;assert.equal(ino,first.ino);
 assert.equal(legacy(p).status,0);const d=child(p);try{const next=await d.send('probe',{});assert.notEqual(next.pid,first.pid);assert.equal(next.ino,first.ino);assert.equal((await d.send('probe-read',{})).data,'ciphertext fixture');}finally{await close(d);}
 assert.equal(fs.statSync(path.join(p,'writer.lock')).ino,ino);
});
test('A live kernel owner rejects concurrent candidate and legacy starts',async t=>{
 const p=home(t),c=child(p);try{const first=await c.send('probe',{});const marker=fs.readFileSync(path.join(p,'writer.lock'));await rejected(p,/BUSY/);assert.equal(legacy(p).status,0);assert.equal(fs.statSync(path.join(p,'writer.lock')).ino,first.ino);assert.deepEqual(fs.readFileSync(path.join(p,'writer.lock')),marker);}finally{await close(c);}
});
test('SIGKILL releases only the lease; same-inode data and legacy barrier remain',async t=>{
 const p=home(t),c=child(p);const first=await c.send('probe',{});await c.send('probe-write',{data:'latest ciphertext only',create:true});
 const before=fs.readFileSync(path.join(p,'vault.json'));c.signal('SIGKILL');const exit=await c.closed;assert.equal(exit.signal,'SIGKILL');await close(c);
 assert.equal(legacy(p).status,0);const d=child(p);try{const next=await d.send('probe',{});assert.equal(next.ino,first.ino);assert.deepEqual(fs.readFileSync(path.join(p,'vault.json')),before);assert.equal((await d.send('probe-read',{})).data,'latest ciphertext only');}finally{await close(d);}
});
test('Explicit loss of the inherited lease makes read/write fail; marker is not enough',async t=>{
 const p=home(t),c=child(p);try{await c.send('probe',{});await c.send('probe-write',{data:'before',create:true});await c.send('probe-drop-lease',{});await assert.rejects(c.send('probe-write',{data:'after'}),/LEASE_NOT_HELD/);assert.equal(fs.readFileSync(path.join(p,'vault.json'),'utf8'),'before');}finally{await close(c);}
});
test('Replacing the lock inode is detected before a write',async t=>{
 const p=home(t),c=child(p);try{await c.send('probe',{});await c.send('probe-write',{data:'before',create:true});fs.renameSync(path.join(p,'writer.lock'),path.join(p,'old-lock'));fs.writeFileSync(path.join(p,'writer.lock'),'realdex.experimental.kernel-lease.v1\n',{mode:0o600});await assert.rejects(c.send('probe-write',{data:'after'}),/LOCK_CHANGED/);assert.equal(fs.readFileSync(path.join(p,'vault.json'),'utf8'),'before');}finally{await close(c);}
});
test('Marker changes are detected before reads as well as writes',async t=>{
 const p=home(t),c=child(p);try{await c.send('probe',{});await c.send('probe-write',{data:'cipher',create:true});fs.writeFileSync(path.join(p,'writer.lock'),'modified',{mode:0o600});await assert.rejects(c.send('probe-read',{}),/LOCK_FORMAT/);assert.equal(fs.readFileSync(path.join(p,'vault.json'),'utf8'),'cipher');}finally{await close(c);}
});
test('Original write path still refuses overwrite on create',async t=>{
 const p=home(t),c=child(p);try{await c.send('probe',{});await c.send('probe-write',{data:'before',create:true});await assert.rejects(c.send('probe-write',{data:'after',create:true}),/HOST_FAILED/);assert.equal(fs.readFileSync(path.join(p,'vault.json'),'utf8'),'before');}finally{await close(c);}
});
