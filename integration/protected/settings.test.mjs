import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {EMPTY_SETTINGS,SETTINGS_SCHEMA,normalizedSettings,settingsRecord,settingsTransition} from '../../wallet/protected/settings.mjs';
import {LEGACY_SETTINGS_WRITES} from '../../wallet/protected/server.mjs';
const ROOT=path.resolve(import.meta.dirname,'../..'),LAUNCH=path.join(import.meta.dirname,'test-launch.py');
const PASS='UP02 disposable settings test passphrase';
const IMPORT=`import fs from 'node:fs';import assert from 'node:assert/strict';import {CheckpointLeaseStore} from './wallet/protected/store.mjs';import {Vault} from './wallet/lib/vault.mjs';import {ProtectedOwnerServer,LEGACY_SETTINGS_WRITES} from './wallet/protected/server.mjs';import {EMPTY_SETTINGS,settingsDigest} from './wallet/protected/settings.mjs';const home=process.argv[1],witness=process.argv[2],password=${JSON.stringify(PASS)},next={...EMPTY_SETTINGS,allowedAppOrigins:['http://localhost:42424']};`;
const SETUP=`const store=new CheckpointLeaseStore(home,witness);const vault=new Vault(store);await vault.create(password);const app=new ProtectedOwnerServer({store,vault});`;
const PREP=`const review=await app.api('/api/protected/settings/prepare',{settings:next});`;
const APPLY=`await app.api('/api/protected/settings/apply',{id:review.id,reviewSha256:review.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK'});`;
function pair(t){const a=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-vault-')),b=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-witness-'));t.after(()=>{fs.rmSync(a,{recursive:true,force:true});fs.rmSync(b,{recursive:true,force:true});});return {a,b};}
function run(p,code,enroll=false){return spawnSync('python3',['-I','-S',LAUNCH,p.a,p.b,enroll?'yes':'no','probe',IMPORT+code],{cwd:ROOT,encoding:'utf8',timeout:30000,maxBuffer:1048576,shell:false});}
function success(r){assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):null;}
const network={chainId:'31337',name:'fixture',symbol:'ETH',rpcUrls:['http://127.0.0.1:8545','http://127.0.0.1:8546'],genesisHash:'0x'+'ab'.repeat(32),broadcastEnabled:false,contracts:[],maxFeeWei:'1000000',maxSlippageBps:0};
test('Settings record is bounded canonical data, never arbitrary plaintext config',()=>{
 const s=normalizedSettings({...EMPTY_SETTINGS,networks:[network]});assert.equal(s.networks[0].rpcUrls[0],'http://127.0.0.1:8545/');assert.ok(Object.isFrozen(s.networks));
 assert.throws(()=>settingsRecord({schema:SETTINGS_SCHEMA,revision:1,settings:{...EMPTY_SETTINGS,networks:[network]}}),/NOT_CANONICAL/);
 assert.throws(()=>settingsRecord({schema:SETTINGS_SCHEMA,revision:0,settings:EMPTY_SETTINGS}),/RECORD/);
 assert.throws(()=>settingsRecord({schema:SETTINGS_SCHEMA,revision:1,settings:s,approved:true}));
});
for(const [name,settings] of [
 ['remote app origin',{...EMPTY_SETTINGS,allowedAppOrigins:['https://example.invalid']}],
 ['an unsupported chain',{...EMPTY_SETTINGS,networks:[{...network,chainId:'999999'}]}],
 ['credentials',{...EMPTY_SETTINGS,networks:[{...network,rpcUrls:['https://user:password@example.invalid','http://127.0.0.1:8546']}]}],
 ['duplicate networks',{...EMPTY_SETTINGS,networks:[network,network]}],
 ['unknown property',{...EMPTY_SETTINGS,signingEnabled:true}],
 ['too many origins',{...EMPTY_SETTINGS,allowedAppOrigins:Array.from({length:9},(_,i)=>'http://localhost:'+String(3000+i))}]
])test('Inherited network/origin policy rejects '+name,()=>assert.throws(()=>normalizedSettings(settings)));
test('Settings replacement preserves original trust-identity restrictions',()=>{
 const before=normalizedSettings({...EMPTY_SETTINGS,networks:[network]});
 assert.throws(()=>settingsTransition(before,EMPTY_SETTINGS),/REMOVAL/);
 assert.throws(()=>settingsTransition(before,{...before,networks:[{...before.networks[0],genesisHash:'0x'+'cd'.repeat(32)}]}),/GENESIS/);
 assert.throws(()=>settingsTransition(EMPTY_SETTINGS,{...EMPTY_SETTINGS,allowedAppOrigins:['http://127.0.0.1:9000']},'http://127.0.0.1:9000'),/SIGNER_ORIGIN/);
 assert.throws(()=>settingsTransition({...EMPTY_SETTINGS,ibcRoutes:[{id:'dummy-existing'}]},EMPTY_SETTINGS),/IDENTITY/);
 const after=settingsTransition(before,{...before,networks:[{...before.networks[0],name:'explicit reviewed label'}]});assert.equal(after.networks[0].name,'explicit reviewed label');
});
test('Read/prepare do not write; apply writes one protected generation and locks',t=>{
 const p=pair(t);success(run(p,SETUP+`const original=fs.readFileSync(store.file,'utf8'),cp=fs.readFileSync(store.cp,'utf8');const read=await app.api('/api/protected/settings',{});assert.equal(read.revision,0);assert.equal(read.persisted,false);`+PREP+`
 assert.equal(fs.readFileSync(store.file,'utf8'),original);assert.equal(fs.readFileSync(store.cp,'utf8'),cp);
 const result=`+APPLY+`assert.equal(result.locked,true);assert.equal(result.revision,1);assert.equal(result.checkpointGeneration,'2');assert.equal(vault.key,null);assert.deepEqual(app.settings.allowedAppOrigins,[]);
 const status=await app.api('/api/status',{});assert.equal(status.protectedSettings.loaded,false);assert.equal(status.protectedSettings.revision,null);
 assert.ok(!fs.readFileSync(store.file,'utf8').includes('localhost:42424'));assert.ok(!fs.readFileSync(store.cp,'utf8').includes('localhost:42424'));await app.close();`,true));
 success(run(p,`const store=new CheckpointLeaseStore(home,witness),app=new ProtectedOwnerServer({store});assert.deepEqual(app.settings.allowedAppOrigins,[]);await app.api('/api/unlock',{password});const value=await app.api('/api/protected/settings',{});assert.deepEqual(value.settings.allowedAppOrigins,next.allowedAppOrigins);assert.equal(value.revision,1);await app.close();`));
});
for(const [name,field,value] of [['wrong hash','reviewSha256','a'.repeat(64)],['wrong ID','id','no'],['wrong confirmation','confirmation','yes']])test('Review rejects '+name+' without mutation',t=>{
 const p=pair(t);success(run(p,SETUP+PREP+`const before=fs.readFileSync(store.file,'utf8');const input={id:review.id,reviewSha256:review.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK',${field}:${JSON.stringify(value)}};await assert.rejects(app.api('/api/protected/settings/apply',input),/CONFIRMATION/);assert.equal(fs.readFileSync(store.file,'utf8'),before);assert.ok(vault.key);await app.close();`,true));
});
test('Draft owns its value; caller mutation cannot change approved bytes',t=>{
 const p=pair(t);success(run(p,SETUP+PREP+`review.after.allowedAppOrigins=[];next.allowedAppOrigins=[];`+APPLY+`await app.api('/api/unlock',{password});assert.deepEqual(app.settings.allowedAppOrigins,['http://localhost:42424']);await app.close();`,true));
});
test('Changing any ciphertext generation invalidates a settings review',t=>{
 const p=pair(t);success(run(p,SETUP+PREP+`vault.save();const before=fs.readFileSync(store.file,'utf8');await assert.rejects(app.api('/api/protected/settings/apply',{id:review.id,reviewSha256:review.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK'}),/EXPIRED_OR_CHANGED/);assert.equal(fs.readFileSync(store.file,'utf8'),before);await app.close();`,true));
});
test('Expiry, explicit lock and autolock revoke draft and hide decrypted configuration',t=>{
 const p=pair(t);success(run(p,`let clock=100000;const store=new CheckpointLeaseStore(home,witness),vault=new Vault(store,{now:()=>clock});await vault.create(password);const app=new ProtectedOwnerServer({store,vault,now:()=>clock});`+PREP+`
 clock+=90001;await assert.rejects(app.api('/api/protected/settings/apply',{id:review.id,reviewSha256:review.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK'}),/EXPIRED_OR_CHANGED/);
 const fresh=await app.api('/api/protected/settings/prepare',{settings:next});await app.api('/api/lock',{});await app.api('/api/unlock',{password});await assert.rejects(app.api('/api/protected/settings/apply',{id:fresh.id,reviewSha256:fresh.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK'}),/CONFIRMATION/);
 const r=await app.api('/api/protected/settings/prepare',{settings:next});await app.api('/api/protected/settings/apply',{id:r.id,reviewSha256:r.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK'});await app.api('/api/unlock',{password});clock+=300001;app.sweep();assert.equal(vault.key,null);assert.deepEqual(app.settings.allowedAppOrigins,[]);await app.close();`,true));
});
for(const expression of ['app.activeApproval=true','app.nonEvm.busy=true','app.dexBusy=true','vault.pendingOperations=1','app.settingsApplying=true'])test('Settings cannot cross active operation: '+expression,t=>{
 const p=pair(t);success(run(p,SETUP+`const before=fs.readFileSync(store.file,'utf8');${expression};await assert.rejects(app.api('/api/protected/settings/prepare',{settings:next}),/BUSY/);assert.equal(fs.readFileSync(store.file,'utf8'),before);vault.pendingOperations=0;await app.close();`,true));
});
test('Settings rejects active monitor and unresolved records, including CheckTx rejection',t=>{
 const p=pair(t);success(run(p,SETUP+`
 app.ibc.monitor.enabled=true;await assert.rejects(app.api('/api/protected/settings/prepare',{settings:next}),/MONITOR_ACTIVE/);app.ibc.monitor.enabled=false;
 const before=fs.readFileSync(store.file,'utf8');
 // In-memory negative fixtures exercise guards ONLY; these are never encoded as valid histories.
 for(const [field,state,report] of [['journal','signed',{}],['nonEvmJournal','broadcast',{}],['injectiveJournal','broadcast-unknown',{}],['injectiveJournal','reported-reverted',{received:false,reason:'CHECKTX_REJECTED',code:1}]]){
  vault.data[field]=[{state,report}];await assert.rejects(app.api('/api/protected/settings/prepare',{settings:next}),/UNRESOLVED_TRANSACTION/);vault.data[field]=[];
 }
 assert.equal(fs.readFileSync(store.file,'utf8'),before);await app.close();`,true));
});
test('Legacy write routes are rejected before locking or unprotected file writes',t=>{
 const p=pair(t);success(run(p,SETUP+`const before=fs.readFileSync(store.file,'utf8');for(const route of LEGACY_SETTINGS_WRITES)await assert.rejects(app.api(route,{}),/REVIEW_REQUIRED/);assert.ok(vault.key);assert.equal(fs.readFileSync(store.file,'utf8'),before);assert.throws(()=>app.saveSettings(next),/REVIEW_REQUIRED/);await app.close();`,true));
});
test('Parallel applies cannot write twice; settings commit invalidates sessions and requests',t=>{
 const p=pair(t);success(run(p,SETUP+PREP+`app.sessions.set('old',{origin:'http://localhost:42424'});app.addRequest({kind:'connect',origin:'http://localhost:42424'});const input={id:review.id,reviewSha256:review.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK'};
 const a=app.api('/api/protected/settings/apply',input);await assert.rejects(app.api('/api/protected/settings/apply',input),/BUSY/);await a;assert.equal(store.info().generation,'2');assert.equal(app.sessions.size,0);assert.ok([...app.requests.values()].every(r=>r.state==='rejected'));await app.close();`,true));
});
test('Emergency lock invalidates a queued settings apply, with zero writes',t=>{
 const p=pair(t);success(run(p,SETUP+PREP+`const before=fs.readFileSync(store.file,'utf8');const job=app.api('/api/protected/settings/apply',{id:review.id,reviewSha256:review.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK'});await app.api('/api/lock',{});await assert.rejects(job,/LOCK_INTERRUPTED/);assert.equal(fs.readFileSync(store.file,'utf8'),before);assert.equal(store.info().generation,'1');assert.equal(vault.key,null);await app.close();`,true));
});
test('Old backup rejected after settings commit; exact backup restores all settings without reset',t=>{
 const p=pair(t);success(run(p,SETUP+`fs.writeFileSync(home+'/old.backup',store.read(),{mode:0o600});`+PREP+APPLY+`await app.api('/api/unlock',{password});const latest=await app.api('/api/backup',{});fs.writeFileSync(home+'/latest.backup',latest.encrypted,{mode:0o600});await app.close();`,true));
 fs.unlinkSync(path.join(p.a,'vault.json'));
 success(run(p,`const store=new CheckpointLeaseStore(home,witness),app=new ProtectedOwnerServer({store});await assert.rejects(app.api('/api/restore',{encrypted:fs.readFileSync(home+'/old.backup','utf8'),password}),/BACKUP_NOT_CURRENT/);const cp=fs.readFileSync(store.cp,'utf8');await app.api('/api/restore',{encrypted:fs.readFileSync(home+'/latest.backup','utf8'),password});assert.equal(fs.readFileSync(store.cp,'utf8'),cp);assert.deepEqual(app.settings.allowedAppOrigins,[]);await app.api('/api/unlock',{password});assert.deepEqual(app.settings.allowedAppOrigins,next.allowedAppOrigins);await app.close();`));
});
for(const stage of ['staged','intent','renamed','vault-durable','checkpoint-durable'])test('Settings I/O failure at '+stage+' returns failure, recovers only recorded ciphertext',t=>{
 const p=pair(t);success(run(p,`let armed=false;const store=new CheckpointLeaseStore(home,witness,{onBoundary:x=>{if(armed&&x===${JSON.stringify(stage)})throw Error('CP_TEST_SETTINGS_SAVE');}}),vault=new Vault(store);await vault.create(password);const app=new ProtectedOwnerServer({store,vault});`+PREP+`armed=true;await assert.rejects(app.api('/api/protected/settings/apply',{id:review.id,reviewSha256:review.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK'}),/CP_TEST_SETTINGS_SAVE/);assert.equal(vault.key,null);assert.deepEqual(app.settings.allowedAppOrigins,[]);await app.close();`,true));
 success(run(p,`const store=new CheckpointLeaseStore(home,witness),app=new ProtectedOwnerServer({store});await app.api('/api/unlock',{password});assert.equal(app.vault.protectedSettings().revision,${stage==='staged'?0:1});assert.equal(store.info().generation,${JSON.stringify(stage==='staged'?'1':'2')});await app.close();`));
});
for(const stage of ['staged','intent','renamed','vault-durable','checkpoint-durable'])test('Actual SIGKILL during settings commit at '+stage+' resumes in the same directory pair',t=>{
 const p=pair(t);const r=run(p,`let armed=false;const store=new CheckpointLeaseStore(home,witness,{onBoundary:x=>{if(armed&&x===${JSON.stringify(stage)})process.kill(process.pid,'SIGKILL');}}),vault=new Vault(store);await vault.create(password);const app=new ProtectedOwnerServer({store,vault});`+PREP+`armed=true;`+APPLY,true);assert.equal(r.signal,'SIGKILL');
 const locks=[p.a,p.b].map(d=>fs.statSync(path.join(d,'writer.lock')).ino);
 success(run(p,`const store=new CheckpointLeaseStore(home,witness),app=new ProtectedOwnerServer({store});await app.api('/api/unlock',{password});assert.equal(app.vault.protectedSettings().revision,${stage==='staged'?0:1});await app.close();`));
 assert.deepEqual([p.a,p.b].map(d=>fs.statSync(path.join(d,'writer.lock')).ino),locks);
});
test('Stale decrypted Vault session cannot replace latest settings',t=>{
 const p=pair(t);success(run(p,SETUP+`const second=new Vault(store);await second.unlock(password);const initial=settingsDigest(second.protectedSettings());`+PREP+APPLY+`await assert.rejects(second.saveProtectedSettings({...next,allowedAppOrigins:[]},initial),/STALE_SESSION/);assert.equal(second.key,null);await app.close();`,true));
});
test('External settings and persistence callbacks are never accepted by the protected server',t=>{
 const p=pair(t);success(run(p,SETUP+`assert.throws(()=>new ProtectedOwnerServer({store,settings:next}),/EXTERNAL_FORBIDDEN/);assert.throws(()=>new ProtectedOwnerServer({store,saveSettings:()=>{}}),/EXTERNAL_FORBIDDEN/);await app.close();`,true));
});
test('Unchanged settings do not generate a new ciphertext or stale the latest backup',t=>{
 const p=pair(t);success(run(p,SETUP+`const before=store.read();await assert.rejects(app.api('/api/protected/settings/prepare',{settings:EMPTY_SETTINGS}),/UNCHANGED/);assert.equal(store.read(),before);await app.close();`,true));
});
test('Real HTTP owner auth still surrounds all new settings endpoints',t=>{
 const p=pair(t);success(run(p,SETUP+`await app.start(0);const headers={'content-type':'application/json',origin:app.origin};for(const endpoint of ['/api/protected/settings','/api/protected/settings/prepare','/api/protected/settings/apply']){const r=await fetch(app.origin+endpoint,{method:'POST',headers,body:'{}'});assert.equal(r.status,401);assert.equal((await r.json()).error,'UI_AUTH_REQUIRED');}
 const r=await fetch(app.origin+'/api/protected/settings',{method:'POST',headers:{...headers,authorization:'Bearer '+app.uiToken},body:'{}'});assert.equal(r.status,200);assert.equal((await r.json()).revision,0);await app.close();`,true));
});

test('A lock while composing status cannot return the earlier decrypted settings',t=>{
 const p=pair(t);success(run(p,SETUP+PREP+APPLY+`await app.api('/api/unlock',{password});const prior=app.pending;app.pending=()=>{vault.lock();return prior.call(app);};const result=await app.api('/api/status',{});assert.equal(result.locked,true);assert.equal(result.protectedSettings.loaded,false);for(const key of ['networks','allowedAppOrigins','solanaNetworks','bitcoinNetworks','accountNetworks','cosmosNetworks','ibcRoutes','accounts'])assert.deepEqual(result[key],[]);await app.close();`,true));
});
