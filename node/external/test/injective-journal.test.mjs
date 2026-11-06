import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {createInjectiveObservationJournal as create,inspectInjectiveObservationJournal as inspect,appendInjectiveObservation as append,JOURNAL_LIMITS} from '../injective-journal.mjs';
import {prepareInjectiveLimitOrder,reconcileInjectiveOrderObservation as reconcile} from '../injective-orders.mjs';
import {demoSnapshot} from '../demo.mjs';import {accountAddress} from '../../../wallet/codec/bech32.mjs';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const cli=new URL('../../spot-order-journal.mjs',import.meta.url).pathname;
const moduleUrl=new URL('../injective-journal.mjs',import.meta.url).href;
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-journal-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const now=1788652800000,sender=accountAddress('inj',Buffer.alloc(20,1));
 const plan=prepareInjectiveLimitOrder(demoSnapshot('injective',now),{requestKey:'journal-test',sender,subaccountId:'0x'+'01'.repeat(20)+'00'.repeat(12),side:'buy',quantity:'1.25',limitPrice:'11'},{now});
 const obs={planSha256:plan.planSha256,clientOrderId:plan.clientOrderId,orderHash:'0x'+'ab'.repeat(32),revision:'1',filledBaseAtomic:'0',status:'open'};
 const dir=path.join(root,'order'),file=path.join(dir,'journal.json');
 const f={root,dir,file,plan,obs,create:()=>create(dir,plan,obs),next:(patch={})=>({...obs,revision:'2',filledBaseAtomic:'10',...patch})};return f;
}
const safe=r=>{for(const k of ['historyAuthenticated','settlementVerified','signingEnabled','broadcastEnabled','executable'])assert.equal(r[k],false);assert.equal(r.state.automaticRetryAllowed,false);assert.equal(r.state.reservationMayBeReleased,false);};
const read=f=>JSON.parse(fs.readFileSync(f.file));
const write=(f,j)=>fs.writeFileSync(f.file,JSON.stringify(j)+'\n');
const rehash=j=>{const {journalSha256,...body}=j;return {...body,journalSha256:sha(body)};};
function child(code,f,more={}){return spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,INPUT:JSON.stringify({dir:f.dir,obs:f.next(),...more})},encoding:'utf8',timeout:20000});}
const preamble=`import fs from 'node:fs';import {appendInjectiveObservation as append,inspectInjectiveObservationJournal as inspect} from ${JSON.stringify(moduleUrl)};const x=JSON.parse(process.env.INPUT);`;
test('Create, reopen, append and inspect retain exact state and all denied authority flags',t=>{
 const f=fixture(t),r=f.create();safe(r);assert.equal(r.entryCount,1);assert.deepEqual(inspect(f.dir),r);
 const n=append(f.dir,f.next(),{expectedHead:r.journalSha256});safe(n);assert.equal(n.entryCount,2);assert.equal(n.state.remainingBaseAtomic,'1249999999999999990');
 assert.deepEqual(inspect(f.dir,{expectedHead:n.journalSha256}),n);assert.deepEqual(fs.readdirSync(f.dir),['journal.json']);
 assert.equal(fs.statSync(f.dir).mode&0o777,0o700);assert.equal(fs.statSync(f.file).mode&0o777,0o600);
});
test('A separate Node process replays persisted history after a clean restart',t=>{
 const f=fixture(t),r=f.create();append(f.dir,f.next(),{expectedHead:r.journalSha256});
 const p=child(preamble+'console.log(JSON.stringify(inspect(x.dir)));',f);assert.equal(p.status,0,p.stderr);assert.deepEqual(JSON.parse(p.stdout),inspect(f.dir));
});
test('Inspection does not mutate journal bytes, timestamps or directory contents',t=>{const f=fixture(t);f.create();const b=fs.readFileSync(f.file),s=fs.statSync(f.file);inspect(f.dir);assert.deepEqual(fs.readFileSync(f.file),b);assert.equal(fs.statSync(f.file).mtimeMs,s.mtimeMs);assert.deepEqual(fs.readdirSync(f.dir),['journal.json']);});
test('Identical latest observation is idempotent without disk replacement or history growth',t=>{
 const f=fixture(t),r=f.create(),s=fs.statSync(f.file),n=append(f.dir,f.obs,{expectedHead:r.journalSha256});
 assert.equal(n.duplicate,true);assert.equal(n.journalSha256,r.journalSha256);assert.equal(n.entryCount,1);assert.equal(fs.statSync(f.file).ino,s.ino);assert.equal(fs.statSync(f.file).mtimeMs,s.mtimeMs);
});
test('An externally pinned head detects whole-history rollback',t=>{
 const f=fixture(t),r=f.create(),old=fs.readFileSync(f.file),n=append(f.dir,f.next(),{expectedHead:r.journalSha256});fs.writeFileSync(f.file,old);
 assert.throws(()=>inspect(f.dir,{expectedHead:n.journalSha256}),/HEAD_MISMATCH/);assert.throws(()=>append(f.dir,f.next({revision:'3'}),{expectedHead:n.journalSha256}),/HEAD_MISMATCH/);
 assert.equal(inspect(f.dir).journalSha256,r.journalSha256); // no external pin cannot authenticate rollback
});
for(const expectedHead of [undefined,null,'','a'.repeat(63),'A'.repeat(64),'0x'+'a'.repeat(64),1])test('Append requires canonical explicit head '+JSON.stringify(expectedHead),t=>{const f=fixture(t);f.create();const b=fs.readFileSync(f.file);assert.throws(()=>append(f.dir,f.next(),{expectedHead}),/HEAD_REQUIRED/);assert.deepEqual(fs.readFileSync(f.file),b);});
for(const [name,patch] of Object.entries({stale:{revision:'1',filledBaseAtomic:'1'},regression:{revision:'3',filledBaseAtomic:'0'},foreign:{planSha256:'f'.repeat(64)},hash:{orderHash:'0x'+'cd'.repeat(32)},overfill:{filledBaseAtomic:'1250000000000000001'}}))test('Invalid '+name+' observation preserves committed state and releases only own lock',t=>{
 const f=fixture(t),r=f.create(),n=append(f.dir,f.next(),{expectedHead:r.journalSha256}),b=fs.readFileSync(f.file);
 assert.throws(()=>append(f.dir,f.next(patch),{expectedHead:n.journalSha256}));assert.deepEqual(fs.readFileSync(f.file),b);assert.deepEqual(fs.readdirSync(f.dir),['journal.json']);
});
test('Creation rejects altered plan before filesystem mutation',t=>{const f=fixture(t);f.plan.baseQuantityAtomic='3';assert.throws(f.create);assert.equal(fs.existsSync(f.dir),false);});
test('Creation never replaces an existing populated or empty directory',t=>{const f=fixture(t);fs.mkdirSync(f.dir,{mode:0o700});assert.throws(f.create,/EXISTS/);assert.deepEqual(fs.readdirSync(f.dir),[]);});
test('Relative and normalized-away paths are not accepted as storage roots',t=>{const f=fixture(t);for(const d of ['relative',f.root+'/x/../order',f.dir+'/'])assert.throws(()=>create(d,f.plan,f.obs),/ABSOLUTE_PATH/);});
test('A non-private parent is rejected without changing permissions',t=>{const f=fixture(t);fs.chmodSync(f.root,0o755);assert.throws(f.create,/PRIVATE_DIRECTORY/);assert.equal(fs.existsSync(f.dir),false);assert.equal(fs.statSync(f.root).mode&0o777,0o755);});
test('Group-readable journal is rejected rather than silently chmodded',t=>{const f=fixture(t);f.create();fs.chmodSync(f.file,0o640);assert.throws(()=>inspect(f.dir),/PRIVATE_FILE/);assert.equal(fs.statSync(f.file).mode&0o777,0o640);});
test('Non-private existing journal directory is rejected',t=>{const f=fixture(t);f.create();fs.chmodSync(f.dir,0o755);assert.throws(()=>inspect(f.dir),/PRIVATE_DIRECTORY/);});
test('Symlink directory cannot redirect reads or writes',t=>{const f=fixture(t);f.create();const d=path.join(f.root,'link');fs.symlinkSync(f.dir,d);assert.throws(()=>inspect(d),/PRIVATE_DIRECTORY|SYMLINK/);});
test('Symlink in a parent path is rejected',t=>{const f=fixture(t);const d=path.join(f.root,'actual');fs.mkdirSync(d,{mode:0o700});fs.symlinkSync(d,path.join(f.root,'link'));assert.throws(()=>create(path.join(f.root,'link','order'),f.plan,f.obs),/PRIVATE_DIRECTORY|SYMLINK/);});
test('Symlink data file is not followed',t=>{const f=fixture(t);f.create();const target=path.join(f.root,'target');fs.renameSync(f.file,target);fs.symlinkSync(target,f.file);assert.throws(()=>inspect(f.dir));assert.ok(fs.lstatSync(f.file).isSymbolicLink());});
test('Hard-linked data is rejected',t=>{const f=fixture(t);f.create();fs.linkSync(f.file,path.join(f.root,'alias'));assert.throws(()=>inspect(f.dir),/PRIVATE_FILE/);});
test('FIFO data cannot hang a reader',t=>{const f=fixture(t);f.create();fs.unlinkSync(f.file);const p=spawnSync('mkfifo',[f.file]);assert.equal(p.status,0);assert.throws(()=>inspect(f.dir),/PRIVATE_FILE/);});
for(const name of ['.write-lock','.journal.pending','unexpected'])test('Existing '+name+' is preserved and blocks use',t=>{const f=fixture(t),r=f.create();const p=path.join(f.dir,name);fs.writeFileSync(p,'evidence',{mode:0o600});assert.throws(()=>inspect(f.dir));assert.throws(()=>append(f.dir,f.next(),{expectedHead:r.journalSha256}));assert.equal(fs.readFileSync(p,'utf8'),'evidence');});
for(const [name,mutate] of Object.entries({
 'state quantity':j=>j.state.remainingBaseAtomic='0',
 'state permission':j=>j.state.executable=true,
 'entry hash':j=>j.entries[0].entrySha256='f'.repeat(64),
 'entry previous hash':j=>j.entries[0].previousSha256='e'.repeat(64),
 'entry swap':j=>j.entries.reverse(),
 'entry deletion':j=>j.entries.shift(),
 'duplicate record':j=>j.entries.push(j.entries.at(-1)),
 'plan altered':j=>j.plan.baseQuantityAtomic='1',
 'empty records':j=>j.entries=[],
 'unknown schema':j=>j.schema='other',
 'extra root field':j=>j.approved=true
}))test('Corrupt '+name+' rejected even with recomputed envelope hash',t=>{
 const f=fixture(t),r=f.create();append(f.dir,f.next(),{expectedHead:r.journalSha256});const j=read(f);mutate(j);write(f,rehash(j));assert.throws(()=>inspect(f.dir));
});
for(const [name,data] of [['truncated','{"schema":'],['empty',''],['non-JSON','NaN'],['two documents','{}\n{}'],['oversized','x'.repeat(JOURNAL_LIMITS.bytes+1)]])test('Invalid file '+name+' rejected',t=>{const f=fixture(t);f.create();fs.writeFileSync(f.file,data);assert.throws(()=>inspect(f.dir));});
test('Duplicate JSON root keys are rejected, not silently accepted by JSON.parse',t=>{const f=fixture(t);f.create();const raw=fs.readFileSync(f.file,'utf8');fs.writeFileSync(f.file,raw.replace('{','{"schema":"ignored",'));assert.throws(()=>inspect(f.dir),/INTEGRITY/);});
test('Unknown whitespace modification is detected by canonical encoding',t=>{const f=fixture(t);f.create();fs.appendFileSync(f.file,' ');assert.throws(()=>inspect(f.dir),/INTEGRITY/);});
test('Same revision duplicates may not be stored as new journal entries',t=>{const f=fixture(t);f.create();const j=read(f);j.entries.push(j.entries[0]);write(f,rehash(j));assert.throws(()=>inspect(f.dir),/DUPLICATE_RECORD/);});
for(const phase of ['before-rename','after-rename'])test('Real child crash '+phase+' retains lock and never exposes a partial journal',t=>{
 const f=fixture(t),r=f.create();const code=preamble+`const rename=fs.renameSync;fs.renameSync=(...a)=>{${phase==='after-rename'?'rename(...a);':''}process.exit(86);};append(x.dir,x.obs,{expectedHead:x.head});`;
 const p=child(code,f,{head:r.journalSha256});assert.equal(p.status,86,p.stderr);assert.ok(fs.existsSync(path.join(f.dir,'.write-lock')));assert.throws(()=>inspect(f.dir),/LOCKED/);
 // Forensic copy only, not an automated recovery operation on the interrupted directory.
 const copy=path.join(f.root,'forensic');fs.mkdirSync(copy,{mode:0o700});fs.copyFileSync(f.file,path.join(copy,'journal.json'));
 assert.equal(inspect(copy).entryCount,phase==='before-rename'?1:2);assert.equal(fs.existsSync(path.join(f.dir,'.journal.pending')),phase==='before-rename');
});
for(const phase of [1,2,3,4])test('Injected fsync failure phase '+phase+' is uncertain and retains lock',t=>{
 const f=fixture(t),r=f.create();const code=preamble+`const sync=fs.fsyncSync;let n=0;fs.fsyncSync=(fd)=>{if(++n===${phase})throw Error('DISK_ERROR');return sync(fd);};try{append(x.dir,x.obs,{expectedHead:x.head});process.exit(2);}catch(e){console.log(e.message);}`;
 const p=child(code,f,{head:r.journalSha256});assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/WRITE_UNCERTAIN/);assert.ok(fs.existsSync(path.join(f.dir,'.write-lock')));assert.throws(()=>inspect(f.dir),/LOCKED/);
});
test('Injected lock unlink failure reports uncertainty even after data commit',t=>{
 const f=fixture(t),r=f.create(),p=child(preamble+`fs.unlinkSync=()=>{throw Error('FAIL');};try{append(x.dir,x.obs,{expectedHead:x.head});process.exit(2);}catch(e){console.log(e.message);}`,f,{head:r.journalSha256});assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/WRITE_UNCERTAIN/);assert.equal(read(f).entries.length,2);assert.throws(()=>inspect(f.dir),/LOCKED/);
});
test('Two real processes cannot lose an update or read through an active writer',async t=>{
 const f=fixture(t),r=f.create();const code=preamble+`const rename=fs.renameSync;fs.renameSync=(...a)=>{fs.writeSync(1,'READY\\n');fs.readSync(0,Buffer.alloc(1),0,1,null);return rename(...a);};console.log(JSON.stringify(append(x.dir,x.obs,{expectedHead:x.head})));`;
 const p=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,INPUT:JSON.stringify({dir:f.dir,obs:f.next(),head:r.journalSha256})},stdio:['pipe','pipe','pipe']});
 t.after(()=>p.kill('SIGKILL'));let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('child readiness timeout')),10000);p.stdout.on('data',()=>{if(stdout.includes('READY')){clearTimeout(timeout);resolve();}});p.on('exit',c=>{clearTimeout(timeout);if(!stdout.includes('READY'))reject(Error('child exited '+c+stderr));});});
 assert.throws(()=>inspect(f.dir),/LOCKED/);
 const second=child(preamble+`try{append(x.dir,x.obs,{expectedHead:x.head});process.exit(2);}catch(e){console.log(e.message);}`,f,{head:r.journalSha256});assert.equal(second.status,0,second.stderr);assert.match(second.stdout,/LOCKED/);
 const exited=new Promise(resolve=>p.once('exit',resolve));p.stdin.end('g');assert.equal(await exited,0,stderr);
 const n=inspect(f.dir);assert.equal(n.entryCount,2);assert.throws(()=>append(f.dir,f.next({revision:'3'}),{expectedHead:r.journalSha256}),/HEAD_MISMATCH/);
});
test('Sequential replay of 64 persisted observations matches the pure reconciler at every restart',t=>{
 const f=fixture(t),r=f.create();let head=r.journalSha256,state=r.state;const rows=[];
 for(let i=2;i<=64;i++){
  const obs=f.next({revision:String(i),filledBaseAtomic:String(BigInt(i)*9007199254740993n)});
  const p=reconcile(f.plan,obs,state);const n=append(f.dir,obs,{expectedHead:head});assert.deepEqual(n.state,p.state);assert.deepEqual(inspect(f.dir).state,p.state);safe(n);head=n.journalSha256;state=n.state;rows.push(state);
 }
 const code='import json,sys\nr=json.load(sys.stdin)\nfor i,x in enumerate(r,2):\n assert int(x["filledBaseAtomic"])==i*9007199254740993\n assert int(x["remainingBaseAtomic"])==1250000000000000000-i*9007199254740993\nprint(len(r))\n';
 const p=spawnSync('python3',['-c',code],{input:JSON.stringify(rows),encoding:'utf8',timeout:10000});assert.equal(p.status,0,p.stderr);assert.equal(p.stdout.trim(),'63');
});
function cliInputs(f){const p=path.join(f.root,'plan.json'),o=path.join(f.root,'observation.json');fs.writeFileSync(p,JSON.stringify(f.plan));fs.writeFileSync(o,JSON.stringify(f.obs));return {p,o};}
const command=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:20000});
test('CLI explicit init, inspect and pinned append persist across processes',t=>{
 const f=fixture(t),{p,o}=cliInputs(f);let r=command(['init','--directory',f.dir,'--plan',p,'--observation',o]);assert.equal(r.status,0,r.stderr);const initial=JSON.parse(r.stdout);safe(initial);
 r=command(['inspect','--directory',f.dir,'--expect-head',initial.journalSha256]);assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),initial);
 fs.writeFileSync(o,JSON.stringify(f.next()));r=command(['append','--directory',f.dir,'--observation',o,'--expect-head',initial.journalSha256]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).entryCount,2);
});
for(const args of [[],['reset'],['inspect'],['inspect','--directory','/tmp','--directory','/tmp'],['append','--directory','/tmp'],['inspect','--directory','/tmp','--force','yes']])test('CLI refuses unsupported or ambiguous mutation '+JSON.stringify(args),()=>{const r=command(args);assert.equal(r.status,1);assert.match(r.stderr,/Usage/);});
for(const raw of ['{"revision":"1","revision":"2"}','{"x":{"a":1,"a":2}}','{"x": [1,]}','[','true false','{"x":"unterminated}', ' '.repeat(4097)])test('CLI rejects malformed/ambiguous input '+sha(raw).slice(0,8),t=>{
 const f=fixture(t),{p,o}=cliInputs(f);fs.writeFileSync(o,raw);const r=command(['init','--directory',f.dir,'--plan',p,'--observation',o]);assert.equal(r.status,1);assert.equal(fs.existsSync(f.dir),false);
});
test('CLI rejects symlink input files',t=>{const f=fixture(t),{p,o}=cliInputs(f);fs.renameSync(o,o+'.real');fs.symlinkSync(o+'.real',o);const r=command(['init','--directory',f.dir,'--plan',p,'--observation',o]);assert.equal(r.status,1);assert.equal(fs.existsSync(f.dir),false);});
test('CLI reports only a stable error code, not private filesystem paths',()=>{const r=command(['inspect','--directory','/private-example-not-present/confidential-order']);assert.equal(r.status,1);assert.ok(!r.stderr.includes('confidential-order'));assert.equal(r.stdout,'');});
test('1024-record capacity permits idempotent latest replay but refuses growth without deletion',t=>{
 const f=fixture(t);f.create();const j=read(f);let prior=j.state,link=j.entries[0].entrySha256;
 for(let i=2;i<=JOURNAL_LIMITS.entries;i++){
  const obs=f.next({revision:String(i),filledBaseAtomic:String(i)}),r=reconcile(f.plan,obs,prior);
  const body={previousSha256:link,observation:obs};const e={...body,entrySha256:sha({domain:j.schema+'/entry',...body})};j.entries.push(e);link=e.entrySha256;prior=r.state;
 }
 j.state=prior;write(f,rehash(j));const before=fs.readFileSync(f.file),r=inspect(f.dir);assert.equal(r.entryCount,1024);
 const n=append(f.dir,j.entries.at(-1).observation,{expectedHead:r.journalSha256});assert.equal(n.duplicate,true);assert.deepEqual(fs.readFileSync(f.file),before);
 assert.throws(()=>append(f.dir,f.next({revision:'1025',filledBaseAtomic:'1025'}),{expectedHead:r.journalSha256}),/ENTRY_LIMIT/);assert.deepEqual(fs.readFileSync(f.file),before);
 j.entries.push(j.entries.at(-1));write(f,rehash(j));assert.throws(()=>inspect(f.dir),/ENTRY_LIMIT/);
});
for(const method of ['writeFileSync','renameSync'])test('Injected '+method+' failure preserves old data and blocks further updates',t=>{
 const f=fixture(t),r=f.create(),before=fs.readFileSync(f.file);
 const patch=method==='renameSync'?`fs.renameSync=()=>{throw Error('RENAME_ERROR');};`:
 `const write=fs.writeFileSync;let n=0;fs.writeFileSync=(fd,data,...rest)=>{if(++n===2){fs.writeSync(fd,Buffer.from(data).subarray(0,16));throw Error('ENOSPC');}return write(fd,data,...rest);};`;
 const p=child(preamble+patch+`try{append(x.dir,x.obs,{expectedHead:x.head});process.exit(2);}catch(e){console.log(e.message);}`,f,{head:r.journalSha256});
 assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/WRITE_UNCERTAIN/);assert.deepEqual(fs.readFileSync(f.file),before);assert.throws(()=>inspect(f.dir),/LOCKED/);assert.ok(fs.existsSync(path.join(f.dir,'.journal.pending')));
});
test('Unsupported storage OS fails explicitly before any filesystem write',t=>{
 const f=fixture(t),p=child(`import {createInjectiveObservationJournal} from ${JSON.stringify(moduleUrl)};Object.defineProperty(process,'platform',{value:'win32'});const x=JSON.parse(process.env.INPUT);try{createInjectiveObservationJournal(x.dir,x.plan,x.first);process.exit(2);}catch(e){console.log(e.message);}`,f,{plan:f.plan,first:f.obs});
 assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/LINUX_REQUIRED/);assert.equal(fs.existsSync(f.dir),false);
});
test('Failed initial creation never allows an existing directory to be silently initialized again',t=>{
 const f=fixture(t),p=child(`import fs from 'node:fs';import {createInjectiveObservationJournal} from ${JSON.stringify(moduleUrl)};const x=JSON.parse(process.env.INPUT);fs.fsyncSync=()=>{throw Error('FAIL');};try{createInjectiveObservationJournal(x.dir,x.plan,x.first);process.exit(2);}catch(e){console.log(e.message);}`,f,{plan:f.plan,first:f.obs});
 assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/WRITE_UNCERTAIN/);assert.ok(fs.existsSync(f.dir));assert.throws(f.create,/EXISTS/);assert.throws(()=>inspect(f.dir),/LAYOUT/);
});
test('Journal hash-chain encoding matches independently computed Python SHA-256',t=>{
 const f=fixture(t),r=f.create();append(f.dir,f.next(),{expectedHead:r.journalSha256});
 const code='import json,hashlib,sys\nj=json.load(sys.stdin)\ndef h(x):return hashlib.sha256(json.dumps(x,ensure_ascii=False,separators=(",", ":")).encode()).hexdigest()\nprev=h({"domain":j["schema"]+"/genesis","planSha256":j["plan"]["planSha256"]})\nfor e in j["entries"]:\n assert e["previousSha256"]==prev\n prev=h({"domain":j["schema"]+"/entry","previousSha256":prev,"observation":e["observation"]})\n assert prev==e["entrySha256"]\nassert h({k:v for k,v in j.items() if k!="journalSha256"})==j["journalSha256"]\nprint(len(j["entries"]))\n';
 const p=spawnSync('python3',['-c',code],{input:fs.readFileSync(f.file),encoding:'utf8',timeout:10000});assert.equal(p.status,0,p.stderr);assert.equal(p.stdout.trim(),'2');
});
