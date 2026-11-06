import test from 'node:test';import assert from 'node:assert/strict';
import {MIGRATION_CASES} from './migration-cases.mjs';
import {validateMigrationTarget,parseMigrationPackage,validateMigrationReceipt} from '../../wallet/protected/migration.mjs';
const registered=[];
const serial=(name,fn)=>{registered.push(name);return test(name,fn);};
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const ROOT=path.resolve(import.meta.dirname,'../..'),LAUNCH=path.join(import.meta.dirname,'test-launch.py');
const PASS='UP03 disposable migration password';
const IMPORT=`import fs from 'node:fs';import assert from 'node:assert/strict';import{CheckpointLeaseStore}from'./wallet/protected/store.mjs';import{Vault}from'./wallet/lib/vault.mjs';import{prepareMigrationTarget,exportProtectedMigration,importProtectedMigration,finalizeProtectedMigration,validateMigrationTarget,validateMigrationReceipt,parseMigrationPackage}from'./wallet/protected/migration.mjs';const home=process.argv[1],witness=process.argv[2],password=${JSON.stringify(PASS)};`;
function pair(t){const a=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-vault-')),b=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-witness-'));t.after(()=>{fs.rmSync(a,{recursive:true,force:true});fs.rmSync(b,{recursive:true,force:true});});return {a,b};}
function run(p,code,{enroll=false,timeout=30000}={}){return spawnSync('python3',['-I','-S',LAUNCH,p.a,p.b,enroll?'yes':'no','probe',IMPORT+code],{cwd:ROOT,encoding:'utf8',timeout,maxBuffer:8*1024*1024,shell:false});}
function success(r){assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):null;}
function source(t,{backup=true,settings=true}={}){const p=pair(t);success(run(p,`const store=new CheckpointLeaseStore(home,witness),v=new Vault(store);await v.create(password);await v.addAccount({family:'evm',label:'migrated-watch',watchAddress:'0x1111111111111111111111111111111111111111'});${backup?`{const b=await v.backup();await v.verifyBackup(b.encrypted,password);}`:''}${settings?`{const before=(await v.protectedSettings()),next={schema:'realdex.wallet-settings.v1',allowedAppOrigins:['http://localhost:42424'],networks:[]};await v.saveProtectedSettings(next,(await import('./wallet/protected/settings.mjs')).settingsDigest(before));}`:''}v.lock();store.close();`,{enroll:true}));return p;}
function target(t){const p=pair(t);const d=success(run(p,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),d=prepareMigrationTarget(s);console.log(JSON.stringify(d));s.close();`,{enroll:true}));return {p,d};}
function exportPkg(p,d,extra=''){return success(run(p,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),v=new Vault(s);await v.unlock(password);${extra}const x=await exportProtectedMigration(s,v,${JSON.stringify(d)});console.log(JSON.stringify({packageText:x.packageText,packageSha256:x.packageSha256,migration:x.migration}));s.close();`));}
function importPkg(p,text){return success(run(p,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),v=new Vault(s),x=await importProtectedMigration(s,v,${JSON.stringify(text)},password);console.log(JSON.stringify(x));s.close();`));}
function finalize(p,receipt,target){const text=JSON.stringify(receipt)+'\n';return success(run(p,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),x=finalizeProtectedMigration(s,${JSON.stringify(text)});console.log(JSON.stringify(x));s.close();`));}

serial('Protected migration freezes source, imports one exact target and retires source after signed receipt',t=>{
 const src=source(t),dst=target(t),pkg=exportPkg(src,dst.d);
 assert.match(run(src,`new CheckpointLeaseStore(home,witness);`).stderr,/CP_MIGRATION_PENDING/);
 const imported=importPkg(dst.p,pkg.packageText);assert.equal(imported.receipt.destinationGeneration,'1');assert.equal(imported.receipt.targetPairId,dst.d.pairId);
 success(run(dst.p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.unlock(password);const status=v.status(),settings=v.protectedSettings();assert.equal(status.accounts.length,1);assert.equal(settings.revision,1);assert.equal(v.data.storageMigration.migrationId,${JSON.stringify(pkg.migration.migrationId)});v.lock();s.close();`));
 const done=finalize(src,imported.receipt,dst.d);assert.equal(done.sourceRetired,true);assert.match(run(src,`new CheckpointLeaseStore(home,witness);`).stderr,/CP_MIGRATED_OUT/);
});

serial('Export is idempotent after freeze and never generates a second migration package',t=>{
 const src=source(t),dst=target(t),a=exportPkg(src,dst.d);
 const b=success(run(src,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),x=await exportProtectedMigration(s,null,${JSON.stringify(dst.d)});console.log(JSON.stringify(x));s.close();`));
 assert.equal(b.existing,true);assert.equal(b.packageText,a.packageText);assert.equal(b.packageSha256,a.packageSha256);
});

serial('Destination import is idempotent and returns the exact signed receipt',t=>{
 const src=source(t),dst=target(t),pkg=exportPkg(src,dst.d),a=importPkg(dst.p,pkg.packageText),b=importPkg(dst.p,pkg.packageText);
 assert.equal(b.alreadyImported,true);assert.deepEqual(b.receipt,a.receipt);
});

serial('Migration ciphertext is target-bound and cannot be imported into another protected pair',t=>{
 const src=source(t),a=target(t),b=target(t),pkg=exportPkg(src,a.d);
 success(run(b.p,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),v=new Vault(s);await assert.rejects(importProtectedMigration(s,v,${JSON.stringify(pkg.packageText)},password),/WRONG_TARGET|MISMATCH/);s.close();`));
});

serial('Wrong password leaves destination generation zero and source frozen',t=>{
 const src=source(t),dst=target(t),pkg=exportPkg(src,dst.d);
 success(run(dst.p,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),v=new Vault(s);await assert.rejects(importProtectedMigration(s,v,${JSON.stringify(pkg.packageText)},'definitely wrong password'),/AUTHENTICATION/);assert.equal(s.info().generation,'0');assert.equal(s.exists(),false);s.close();`));
 assert.match(run(src,`new CheckpointLeaseStore(home,witness);`).stderr,/MIGRATION_PENDING/);
});

serial('Source without a verified current backup cannot enter migration',t=>{
 const src=source(t,{backup:false,settings:false}),dst=target(t);
 success(run(src,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),v=new Vault(s);await v.unlock(password);await assert.rejects(exportProtectedMigration(s,v,${JSON.stringify(dst.d)}),/BACKUP_VERIFICATION_REQUIRED/);assert.equal(s.migrationState(),null);v.lock();s.close();`));
});

serial('Unresolved transaction state cannot migrate and cannot freeze the source',t=>{
 const src=source(t),dst=target(t);
 success(run(src,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),v=new Vault(s);await v.unlock(password);v.data.injectiveJournal=[{state:'broadcast-unknown'}];await assert.rejects(exportProtectedMigration(s,v,${JSON.stringify(dst.d)}),/UNRESOLVED_TRANSACTION/);assert.equal(s.migrationState(),null);v.data.injectiveJournal=[];v.lock();s.close();`));
});

serial('Persistent agent authority is revoked in the migrated encrypted payload',t=>{
 const src=source(t),dst=target(t);
 success(run(src,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.unlock(password);
 const {normalizePolicy,validateAgentData,tokenHash}=await import('./wallet/lib/agent-policy.mjs');
 const account=await v.addAccount({family:'evm',label:'disposable-agent-account'}),now=Date.now();
 const network={chainId:'31337',genesisHash:'0x'+'ab'.repeat(32),symbol:'TEST',broadcastEnabled:true,maxFeeWei:'1000000'};
 const policy=normalizePolicy({label:'disposable-migration-policy',accountId:account.id,chainId:'31337',asset:'native',recipients:['0x2222222222222222222222222222222222222222'],mode:'auto',expiresAt:now+60000,
 limits:{perTransferAtomic:'1',rolling24hAtomic:'2',lifetimeAtomic:'3',perTxFeeWei:'1',rolling24hFeeWei:'2',lifetimeFeeWei:'3',maxTransfers:1,minIntervalMs:0}},network,account,now,(await import('node:crypto')).randomUUID());
 policy.tokenHash=tokenHash('UP03 disposable capability');v.data.agentPolicies=[policy];v.data.agentRequests=[];validateAgentData(v.data);v.save();
 assert.equal(v.data.agentPolicies.length,1);assert.equal(v.data.agentPolicies[0].status,'active');assert.match(v.data.agentPolicies[0].tokenHash,/^[a-f0-9]{64}$/);
 const backup=await v.backup();await v.verifyBackup(backup.encrypted,password);v.lock();s.close();`));
 const pkg=exportPkg(src,dst.d),r=importPkg(dst.p,pkg.packageText);assert.equal(r.receipt.targetPairId,dst.d.pairId);
 success(run(dst.p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.unlock(password);assert.equal(v.data.agentPolicies.length,1);assert.equal(v.data.agentPolicies[0].status,'revoked');assert.equal(v.data.agentPolicies[0].tokenHash,null);(await import('./wallet/lib/agent-policy.mjs')).validateAgentData(v.data);v.lock();s.close();`));
});

serial('Tampering package ciphertext, migration metadata or target descriptor is rejected before destination write',t=>{
 const src=source(t),dst=target(t),pkg=exportPkg(src,dst.d),base=JSON.parse(pkg.packageText);
 const variants=[];
 const a=structuredClone(base);a.encrypted=a.encrypted.slice(0,-2)+'xx';variants.push(a);
 const b=structuredClone(base);b.encryptedSha256='f'.repeat(64);variants.push(b);
 const c=structuredClone(base);c.migration.targetPairId='a'.repeat(64);variants.push(c);
 const d=structuredClone(base);d.targetDescriptor.nonce='b'.repeat(64);variants.push(d);
 for(const bad of variants)success(run(dst.p,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),v=new Vault(s);await assert.rejects(importProtectedMigration(s,v,JSON.stringify(${JSON.stringify(bad)})+'\\n',password));assert.equal(s.info().generation,'0');s.close();`));
 for(const [field,value] of [['vaultId','00000000-0000-0000-0000-000000000000'],['accountsVersion',base.accountsVersion+1],['revision',base.revision+1]]){
  const changed=structuredClone(base);changed[field]=value;
  success(run(dst.p,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),v=new Vault(s);await assert.rejects(importProtectedMigration(s,v,JSON.stringify(${JSON.stringify(changed)})+'\\n',password),{message:'CP_MIGRATION_METADATA_MISMATCH'});assert.equal(s.info().generation,'0');assert.equal(s.exists(),false);s.close();`));
 }
});

serial('Forged or modified destination receipt cannot retire source',t=>{
 const src=source(t),dst=target(t),pkg=exportPkg(src,dst.d),imp=importPkg(dst.p,pkg.packageText);
 for(const patch of [{destinationCiphertextSha256:'f'.repeat(64)},{signatureBase64:Buffer.alloc(64).toString('base64')},{targetPairId:'a'.repeat(64)}]){
  const bad={...imp.receipt,...patch};success(run(src,`const s=new CheckpointLeaseStore(home,witness,{migration:true});assert.throws(()=>finalizeProtectedMigration(s,${JSON.stringify(JSON.stringify(bad)+'\n')}));assert.equal(s.migrationState().phase,'pending');s.close();`));
 }
});

serial('Receipt is bound to the exact package and source migration ID',t=>{
 const a=source(t),b=source(t),ta=target(t),tb=target(t),pa=exportPkg(a,ta.d),pb=exportPkg(b,tb.d),ra=importPkg(ta.p,pa.packageText).receipt,rb=importPkg(tb.p,pb.packageText).receipt;
 success(run(a,`const s=new CheckpointLeaseStore(home,witness,{migration:true});assert.throws(()=>finalizeProtectedMigration(s,${JSON.stringify(JSON.stringify(rb)+'\n')}),/RECEIPT/);assert.equal(s.migrationState().phase,'pending');s.close();`));
 finalize(a,ra,ta.d);
});

serial('Crash after migration package write freezes normal source and rerun reconstructs marker without new ciphertext',t=>{
 const src=source(t),dst=target(t);
 const r=run(src,`const s=new CheckpointLeaseStore(home,witness,{migration:true,onBoundary:x=>{if(x==='migration-package')process.kill(process.pid,'SIGKILL');}}),v=new Vault(s);await v.unlock(password);await exportProtectedMigration(s,v,${JSON.stringify(dst.d)});`);assert.equal(r.signal,'SIGKILL');
 assert.match(run(src,`new CheckpointLeaseStore(home,witness);`).stderr,/MIGRATION_PENDING/);
 const repaired=success(run(src,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),state=s.migrationState(),p=parseMigrationPackage(state.packageText),x=await exportProtectedMigration(s,null,${JSON.stringify(dst.d)});assert.equal(x.packageText,state.packageText);assert.equal(s.migrationState().phase,'pending');console.log(JSON.stringify({sha:x.packageSha256,id:p.migration.migrationId}));s.close();`));assert.ok(repaired.sha);
});

serial('Crash after destination ciphertext commit but before receipt can resume without writing a second generation',t=>{
 const src=source(t),dst=target(t),pkg=exportPkg(src,dst.d);
 const r=run(dst.p,`const s=new CheckpointLeaseStore(home,witness,{migration:true,onBoundary:x=>{if(x==='checkpoint-durable')process.kill(process.pid,'SIGKILL');}}),v=new Vault(s);await importProtectedMigration(s,v,${JSON.stringify(pkg.packageText)},password);`);assert.equal(r.signal,'SIGKILL');
 const resumed=importPkg(dst.p,pkg.packageText);assert.equal(resumed.receipt.destinationGeneration,'1');
 success(run(dst.p,`const s=new CheckpointLeaseStore(home,witness,{migration:true});assert.equal(s.info().generation,'1');s.close();`));
});

serial('Destination already containing another Vault is never overwritten',t=>{
 const src=source(t),dst=target(t),pkg=exportPkg(src,dst.d);
 success(run(dst.p,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),v=new Vault(s);await v.create(password);v.lock();s.close();`));
 success(run(dst.p,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),v=new Vault(s);await assert.rejects(importProtectedMigration(s,v,${JSON.stringify(pkg.packageText)},password),/TARGET_NOT_EMPTY|STORAGE_PROTECTION_MISMATCH/);assert.equal(s.info().generation,'1');s.close();`));
});

serial('Source remains byte-identical while pending and retired; migration never rewrites the old ciphertext',t=>{
 const src=source(t),dst=target(t),before=fs.readFileSync(path.join(src.a,'vault.json')),pkg=exportPkg(src,dst.d);assert.deepEqual(fs.readFileSync(path.join(src.a,'vault.json')),before);const imp=importPkg(dst.p,pkg.packageText);finalize(src,imp.receipt,dst.d);assert.deepEqual(fs.readFileSync(path.join(src.a,'vault.json')),before);
});

serial('Migrated destination preserves account identity/settings but carries distinct storage pair and provenance',t=>{
 const src=source(t),dst=target(t),pkg=exportPkg(src,dst.d),imp=importPkg(dst.p,pkg.packageText);
 success(run(dst.p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.unlock(password);assert.equal(v.data.storageProtection.pairId,${JSON.stringify(dst.d.pairId)});assert.equal(v.data.storageMigration.sourcePairId,${JSON.stringify(pkg.migration.sourcePairId)});assert.equal(v.publicAccounts()[0].address,'0x1111111111111111111111111111111111111111');assert.equal(v.protectedSettings().revision,1);v.lock();s.close();`));
 finalize(src,imp.receipt,dst.d);
});

serial('Target descriptor is stable across restarts and is tied to its stored Ed25519 private key',t=>{
 const dst=target(t),again=success(run(dst.p,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),d=prepareMigrationTarget(s);console.log(JSON.stringify(d));s.close();`));assert.deepEqual(again,dst.d);
 fs.unlinkSync(path.join(dst.p.b,'migration-receipt-key.pk8'));
 assert.notEqual(run(dst.p,`const s=new CheckpointLeaseStore(home,witness,{migration:true});prepareMigrationTarget(s);`).status,0);
});

serial('Target descriptor, package and receipt validators reject extra fields and bad signatures',t=>{
 const src=source(t),dst=target(t),pkg=exportPkg(src,dst.d),imp=importPkg(dst.p,pkg.packageText);
 assert.deepEqual(validateMigrationTarget(dst.d),dst.d);assert.equal(parseMigrationPackage(pkg.packageText).vaultId,imp.receipt.vaultId);assert.deepEqual(validateMigrationReceipt(imp.receipt,dst.d),imp.receipt);
 assert.throws(()=>validateMigrationTarget({...dst.d,extra:true}),{message:'SCHEMA_INVALID'});assert.throws(()=>parseMigrationPackage(pkg.packageText.replace('"schema":','"extra":1,"schema":')),{message:'SCHEMA_INVALID'});
 assert.throws(()=>validateMigrationReceipt({...imp.receipt,signatureBase64:Buffer.alloc(64,1).toString('base64')},dst.d),{message:'CP_MIGRATION_RECEIPT_SIGNATURE'});
});

serial('Migration files use owner-only regular files and normal target can open only after imported ciphertext exists',t=>{
 const src=source(t),dst=target(t),pkg=exportPkg(src,dst.d);for(const f of ['migration-target.json','migration-receipt-key.pk8']){const s=fs.lstatSync(path.join(dst.p.b,f));assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.mode&0o077,0);}
 assert.notEqual(run(dst.p,`const s=new CheckpointLeaseStore(home,witness);const v=new Vault(s);await v.unlock(password);`).status,0);
 importPkg(dst.p,pkg.packageText);success(run(dst.p,`const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);await v.unlock(password);v.lock();s.close();`));
});

serial('There is deliberately no source migration abort API after export',t=>{
 const src=source(t),dst=target(t);exportPkg(src,dst.d);success(run(src,`const s=new CheckpointLeaseStore(home,witness,{migration:true});assert.equal(typeof s.abortMigration,'undefined');assert.equal(s.migrationState().phase,'pending');s.close();`));
});

serial('Migration source and destination pair must be distinct',t=>{
 const src=source(t),dst=target(t);
 success(run(src,`const s=new CheckpointLeaseStore(home,witness,{migration:true}),v=new Vault(s);await v.unlock(password);
 const {canonical}=await import('./wallet/lib/guard.mjs'),{createHash}=await import('node:crypto');
 const target=${JSON.stringify(dst.d)};target.pairId=s.protection.pairId;const {descriptorSha256,...body}=target;target.descriptorSha256=createHash('sha256').update(canonical(body)).digest('hex');
 validateMigrationTarget(target);await assert.rejects(exportProtectedMigration(s,v,target),{message:'VAULT_STORAGE_MIGRATION_INVALID'});assert.equal(s.migrationState(),null);v.lock();s.close();`));
});

assert.deepEqual(registered,MIGRATION_CASES.map(item=>item.name),'Every migration scenario must belong to the official runner');
