import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {sourceIdentity} from '../identity.mjs';import {verifyReferenceInventory,requireReferenceSource,SCHEDULER_BLOBS} from '../reference-guard.mjs';
import {GATE_IDS,RUNTIME_TESTS,decideOwnerAcceptance,strictJson,validateScenarioDirectory} from '../acceptance.mjs';import {parseAcceptanceArgs} from '../run-acceptance.mjs';
import {fixture,PIN} from './concurrency-fixture.mjs';import {sha} from '../protocol.mjs';
const entry=(p,oid='a'.repeat(40),mode='100644')=>({path:p,oid,mode});
const baseline=()=>[entry('wallet/lib/vault.mjs'),entry('wallet/test/run.mjs','b'.repeat(40)),entry('package.json','c'.repeat(40))];
function scheduled(){const b=baseline();b[1].oid=SCHEDULER_BLOBS[b[1].path];return [...b,...Object.entries(SCHEDULER_BLOBS).filter(([p])=>p!=='wallet/test/run.mjs').map(([p,h])=>entry(p,h)),entry('integration/owner-e2e/run.mjs'),entry('docs/validation/E2E06-OWNER-ACCEPTANCE.md'),entry('app/test/owner-acceptance-addon.test.mjs')];}
test('Fixed product inventory accepts unchanged baseline plus validation only',()=>{assert.equal(verifyReferenceInventory(baseline(),baseline()).protectedFiles,2);const v=verifyReferenceInventory(baseline(),scheduled());assert.equal(v.checkpointCompatibilityVerified,false);assert.equal(v.productSuccessor,false);});
for(const [name,change] of Object.entries({
 'product byte change':a=>{a[0].oid='f'.repeat(40);},'product removal':a=>a.shift(),'product mode change':a=>{a[0].mode='100755';},
 'unreviewed scheduler':a=>{a[1].oid='f'.repeat(40);},'missing scheduler implementation':a=>a.splice(3,1),
 'new wallet implementation':a=>a.push(entry('wallet/lib/checkpoint.mjs')),'new root execution':a=>a.push(entry('server.mjs')),
 'workflow change':a=>a.push(entry('.github/workflows/new.yml')),'new product API':a=>a.push(entry('node/external/new.mjs')),
 'symlink in tests':a=>a.push(entry('integration/owner-e2e/link','a'.repeat(40),'120000')),
 'duplicate path':a=>a.push(a[0]),'traversal':a=>a.push(entry('integration/owner-e2e/../../wallet/new.mjs'))
}))test('Reference protection rejects '+name,()=>{const a=scheduled();change(a);assert.throws(()=>verifyReferenceInventory(baseline(),a),/E2E_REFERENCE/);});
const hasReferenceHistory=(()=>{try{execFileSync('git',['cat-file','-e','a0bb48445bc4d626806697475fc7965485b1a9ac^{commit}'],{cwd:path.resolve(import.meta.dirname,'../../..'),stdio:'ignore'});return true;}catch{return false;}})();
test('Historical E2E08 reference passes its immutable inventory; UP01 is correctly rejected by the old reference-only gate',{skip:hasReferenceHistory?false:'requires the maintainers\' git history (commit a0bb484...), which is not part of the public tree'},()=>{
 const root=path.resolve(import.meta.dirname,'../../..'),git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 const read=ref=>git(['ls-tree','-r',ref]).split('\n').map(line=>{const m=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);assert.ok(m);return {mode:m[1],oid:m[2],path:m[3]};});
 const v=verifyReferenceInventory(read('a0bb48445bc4d626806697475fc7965485b1a9ac'),read('5e185fbf6fd28569e7b4e68c04d6deb19d9515a3'));
 assert.equal(v.referenceProduct,'INJ12');assert.ok(v.protectedFiles>1000);
 assert.throws(()=>requireReferenceSource(root),/E2E_REFERENCE_PRODUCT_CHANGED|E2E_REFERENCE_ADDITION_OUTSIDE_SCOPE/);
});
function repo(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e06-identity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const git=a=>execFileSync('git',a,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);fs.writeFileSync(root+'/code.mjs','first');git(['add','.']);git(['commit','-qm','fixture']);return {root,git,pins:{expectedCommit:git(['rev-parse','HEAD']),expectedTree:git(['rev-parse','HEAD^{tree}'])}};}
for(const flag of ['--assume-unchanged','--skip-worktree'])test('Actual blob mismatch is caught even when git status is clean '+flag,t=>{const f=repo(t);f.git(['update-index',flag,'code.mjs']);fs.writeFileSync(f.root+'/code.mjs','other');assert.equal(f.git(['status','--porcelain']),'');assert.throws(()=>sourceIdentity(f.root,f.pins),/BLOB_MISMATCH/);});
test('Executable mode is checked even with core.fileMode=false',t=>{const f=repo(t);f.git(['config','core.fileMode','false']);fs.chmodSync(f.root+'/code.mjs',0o755);assert.equal(f.git(['status','--porcelain']),'');assert.throws(()=>sourceIdentity(f.root,f.pins),/MODE_MISMATCH/);});
const goodGates=()=>GATE_IDS.map(id=>({id,status:id==='browser'?'not-run':'passed'}));
test('API acceptance can pass while browser/full/checkpoint remain explicitly unapproved',()=>{const v=decideOwnerAcceptance('api',goodGates(),{sourceStable:true,runtimeStable:true});assert.equal(v.apiPassed,true);assert.equal(v.requestedScopePassed,true);for(const k of ['browserEndToEndPassed','productionReady','wholeProductAcceptance','checkpointCompatibilityVerified','productSuccessor'])assert.equal(v[k],false);});
for(const status of ['failed','blocked','not-run'])for(const id of GATE_IDS.slice(0,-1))test('Required API gate '+id+' cannot be '+status,()=>{const g=goodGates();g.find(x=>x.id===id).status=status;assert.equal(decideOwnerAcceptance('api',g,{sourceStable:true,runtimeStable:true}).requestedScopePassed,false);});
test('Browser scope cannot be satisfied by API data or an omitted browser run',()=>{assert.throws(()=>decideOwnerAcceptance('browser',goodGates(),{sourceStable:true,runtimeStable:true}),/BROWSER_SCOPE/);for(const status of ['blocked','failed']){const g=goodGates();g.at(-1).status=status;assert.equal(decideOwnerAcceptance('browser',g,{sourceStable:true,runtimeStable:true}).requestedScopePassed,false);}const g=goodGates();g.at(-1).status='passed';assert.equal(decideOwnerAcceptance('browser',g,{sourceStable:true,runtimeStable:true}).browserEndToEndPassed,true);});
for(const k of ['sourceStable','runtimeStable'])test('Stability false rejects whole requested scope: '+k,()=>assert.equal(decideOwnerAcceptance('api',goodGates(),{sourceStable:true,runtimeStable:true,[k]:false}).requestedScopePassed,false));
for(const [n,m] of Object.entries({'missing':g=>g.pop(),'duplicate':g=>{g[1]=g[0];},'unknown':g=>{g[0].id='unknown';},'reordered':g=>g.reverse(),'fake-status':g=>{g[0].status='approved';}}))test('Aggregate gate set '+n+' is rejected',()=>{const g=goodGates();m(g);assert.throws(()=>decideOwnerAcceptance('api',g,{sourceStable:true,runtimeStable:true}));});
test('Planned runtime test set contains all seven suites, never a filter/shard',()=>{assert.equal(RUNTIME_TESTS.length,7);assert.ok(RUNTIME_TESTS.every(n=>/^integration\/injective\/[A-Za-z]+\.test\.mjs$/.test(n)));assert.ok(Object.isFrozen(RUNTIME_TESTS));});
const cli=['--profile','api','--runtime-dir','/tools','--output','/new','--expect-commit','a'.repeat(40),'--expect-tree','b'.repeat(40)];
test('CLI requires explicit profile, full identity and output',()=>{assert.equal(parseAcceptanceArgs(cli).profile,'api');for(const args of [[],cli.slice(0,-2),[...cli,'--retry','1'],[...cli,'--profile','api'],['--profile','quick',...cli.slice(2)]])assert.throws(()=>parseAcceptanceArgs(args));});
for(const text of ['{"a":1,"a":2}','{"x":NaN}','{"a":0} trailing','{"__proto__":{}}'])test('Receipt JSON rejects ambiguity '+text,()=>assert.throws(()=>strictJson(Buffer.from(text))));
function directory(t){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'e2e06-evidence-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));
 const files=[{path:'code.mjs',bytes:1,mode:'100644',sha256:sha('x')}];const identity={commit:PIN.expectedCommit,tree:PIN.expectedTree,files,digest:sha(JSON.stringify(files)),trackedFiles:1};
 const time=Date.now(),execution={status:0,signal:null,error:null,startedAt:new Date(time-100).toISOString(),finishedAt:new Date(time+100).toISOString()};
 const r={...fixture(),sourceDigest:identity.digest,trackedFiles:1,createdAt:new Date(time).toISOString(),nodeVersion:process.versions.node,durationMs:5};
 const put=(n,o)=>fs.writeFileSync(path.join(d,n),JSON.stringify(o)+'\n');
 put('source-before.json',identity);put('source-after.json',identity);put('result.json',r);fs.writeFileSync(d+'/steps.ndjson','');
 const seal=()=>put('FILES.json',['source-before.json','source-after.json','result.json','steps.ndjson'].sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(d,p)))})));seal();
 return {d,r,identity,execution,put,seal,validate:()=>validateScenarioDirectory(d,'concurrency',identity,execution)};
}
test('Complete synthetic result passes directory validation but is not runtime evidence',t=>{const f=directory(t);assert.equal(f.validate().scenarioChecks,55);});
for(const [name,mutate] of Object.entries({
 'old timestamp':f=>{f.r.createdAt='2020-01-01T00:00:00Z';f.put('result.json',f.r);f.seal();},
 'counterfeit commit':f=>{f.r.commit='f'.repeat(40);f.put('result.json',f.r);f.seal();},
 'modified accounting with recomputed hashes':f=>{f.r.cases[0].after.base='0';f.put('result.json',f.r);f.seal();},
 'modified source with recomputed hashes':f=>{f.put('source-after.json',{...f.identity,digest:'f'.repeat(64)});f.seal();},
 'extra output':f=>f.put('secret.json',{}),'missing output':f=>fs.unlinkSync(f.d+'/steps.ndjson'),
 'unsealed report':f=>fs.appendFileSync(f.d+'/result.json',' '),
 'symlink evidence':f=>{fs.unlinkSync(f.d+'/steps.ndjson');fs.symlinkSync('result.json',f.d+'/steps.ndjson');f.seal();},
 'failed child':f=>{f.execution.status=1;},'interrupted child':f=>{f.execution.signal='SIGTERM';},'child error':f=>{f.execution.error={code:'CI_TIMEOUT'};},
 'foreign Node evidence':f=>{f.r.nodeVersion='0.0.0';f.put('result.json',f.r);f.seal();}
}))test('Scenario evidence rejects '+name,t=>{const f=directory(t);mutate(f);assert.throws(f.validate);});
