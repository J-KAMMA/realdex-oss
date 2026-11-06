import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {verifyFailureEvidence,failureArm,releaseGate,failedReceipt,failureHome,FALSE_FLAGS} from '../failure-protocol.mjs';
import {parseFailureArgs} from '../run-failure.mjs';import {sha} from '../protocol.mjs';import {evidenceFixture,pins} from './failure-fixture.mjs';
test('Synthetic result validates both failure paths, without becoming a chain proof',()=>assert.equal(verifyFailureEvidence(evidenceFixture(),pins),true));
const changes={
 'wrong source':r=>r.commit='f'.repeat(40),'wrong tree':r=>r.tree='f'.repeat(40),'wrong profile':r=>r.mode='browser',
 'missing case':r=>r.cases.pop(),'reordered cases':r=>r.cases.reverse(),'same case twice':r=>r.cases[1]=r.cases[0],
 'missing check':r=>r.cases[0].checks.pop(),'duplicate check':r=>r.cases[0].checks[1]=r.cases[0].checks[0],
 'hidden extra send':r=>r.cases[0].firstProcessSends++,'restart resend':r=>r.cases[0].afterReconcileSends=1,
 'success substituted':r=>r.cases[0].receipt.code=0,'other module error':r=>r.cases[0].receipt.codespace='bank',
 'other exchange error':r=>r.cases[0].receipt.code=20,
 'absent receipt':r=>r.cases[0].receipt=null,'CheckTx-only rejection':r=>r.cases[0].checkTxCode=19,
 'string code':r=>r.cases[0].receipt.code='19','negative code':r=>r.cases[0].receipt.code=-1,
 'zero height':r=>r.cases[0].receipt.height='0','unknown lookup':r=>r.cases[0].lookupStatus=404,
 'wrong tx hash':r=>r.cases[0].receipt.hash='F'.repeat(64),'hash reused':r=>r.cases[1].successorHash=r.cases[0].orderHash,
 'gas cap changed':r=>r.cases[0].receipt.gasWanted='999999','gas zero':r=>r.cases[0].receipt.gasUsed='0',
 'gas over cap':r=>r.cases[0].receipt.gasUsed='1000001','changed signature':r=>r.cases[0].restoredSignedSha256='d'.repeat(64),
 'failure relabeled success':r=>r.cases[0].failedState='reported-confirmed','failure relabeled unsent':r=>r.cases[0].failedReason='UNSENT',
 'action effects attached':r=>r.cases[0].actionEffectPresent=true,'retirement attached':r=>r.cases[0].retirementPresent=true,
 'automatic retry authorized':r=>r.cases[0].automaticRetry=true,'false finality':r=>r.cases[0].finalityProven=true,
 'receipt not received':r=>r.cases[0].failureReceived=false,'old token accepted':r=>r.cases[0].oldTokenStatus=200,
 'same process claimed restart':r=>r.cases[0].restartedPid=r.cases[0].oldPid,'same token':r=>r.cases[0].newTokenDistinct=false,
 'unresolved guard absent':r=>r.cases[0].unresolvedError='OK','resubmit allowed':r=>r.cases[0].resubmitError='OK',
 'fees refunded incorrectly':r=>r.cases[0].afterFailure.gas=r.cases[0].beforeFailure.gas,
 'sequence not consumed':r=>r.cases[0].afterFailure.sequence='1','failed action changed asset':r=>r.cases[0].afterFailure.base='1',
 'failed action changed quote':r=>r.cases[0].afterFailure.quote='43','followup double amount':r=>r.cases[0].afterSuccessor.exchangeBase='500000000000000000',
 'negative balance':r=>r.cases[0].beforeFailure.gas='-1','number instead of integer string':r=>r.cases[0].beforeFailure.sequence=1,
 'order remained':r=>r.cases[0].beforeFailure.openOrders=1,'nonce changed by race':r=>r.cases[0].preRaceSequence='2',
 'idempotent reconcile wrote':r=>r.cases[0].reconcileWriteDelta=1,'terminal lookup repeated':r=>r.cases[0].reconcileQueryDelta=1,
 'failure lost at restart':r=>r.cases[0].failurePersistsAfterSecondRestart=false,
 'wrong crash signal':r=>r.cases[1].exit.signal='SIGTERM','HTTP timeout called crash':r=>r.cases[1].httpResult='timeout',
 'stale lock removed':r=>r.cases[1].staleLockPreserved=false,'automatic lock recovery':r=>r.cases[1].sameHomeAutoRecovered=true,
 'copy not identified':r=>r.cases[1].fixtureCopyOnly=false,'copy altered':r=>r.cases[1].copiedCiphertextSha256='e'.repeat(64),
 'crash marker tx mismatch':r=>r.cases[1].crashMarker.requestHash='F'.repeat(64),
 'wrong marker fee':r=>r.cases[1].crashMarker.receipt={...r.cases[1].receipt,gasWanted:'2'},
 'barrier before persistence':r=>r.cases[0].barrier.state='signed','barrier sent already':r=>r.cases[0].barrier.ownerSends=2,
 'wrong total':r=>r.ownerSubmissions=4,'source changed':r=>r.sourceStable=false
};
for(const [name,mutate] of Object.entries(changes))test('Reject corrupt failure evidence: '+name,()=>{const r=evidenceFixture();mutate(r);assert.throws(()=>verifyFailureEvidence(r,pins));});
for(const k of FALSE_FLAGS)test('No implicit authority '+k,()=>{const r=evidenceFixture();r[k]=true;assert.throws(()=>verifyFailureEvidence(r,pins));});
for(const p of [{mode:'response',requestHash:'A'.repeat(64),broadcast:true},{mode:'resend',requestHash:'A'.repeat(64)},{mode:'response',requestHash:'a'.repeat(64)},null])test('Arm rejects '+JSON.stringify(p),()=>assert.throws(()=>failureArm(p)));
test('Release gate binds the exact saved transaction',()=>{assert.equal(releaseGate({schema:'realdex.failure-release.v1',requestHash:'A'.repeat(64)},'A'.repeat(64)),true);assert.throws(()=>releaseGate({schema:'realdex.failure-release.v1',requestHash:'B'.repeat(64)},'A'.repeat(64)));});
for(const args of [[],['--output','x'],['--broadcast','yes'],['--runtime-dir','x','--runtime-dir','y'],['--output','--expect-commit']])test('Strict CLI arguments '+JSON.stringify(args),()=>assert.throws(()=>parseFailureArgs(args)));
test('Fixture directories reject links, public permissions and user-like storage names',t=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-e2e03-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));assert.equal(failureHome(d),d);
 fs.chmodSync(d,0o755);assert.throws(()=>failureHome(d));fs.chmodSync(d,0o700);assert.throws(()=>failureHome(d+'/..'));
 const link=d+'-link';t.after(()=>fs.rmSync(link,{force:true}));fs.symlinkSync(d,link);assert.throws(()=>failureHome(link));
});
function filesFixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e03-evidence-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const files=[{path:'fixture.mjs',bytes:0,mode:'100644',sha256:sha('')}],snapshot={commit:pins.expectedCommit,tree:pins.expectedTree,files,digest:sha(JSON.stringify(files)),trackedFiles:1};
 const result={...evidenceFixture(),sourceDigest:snapshot.digest};
 fs.writeFileSync(path.join(dir,'source-before.json'),JSON.stringify(snapshot));fs.writeFileSync(path.join(dir,'source-after.json'),JSON.stringify(snapshot));fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result));
 fs.writeFileSync(path.join(dir,'steps.ndjson'),result.cases.flatMap(c=>c.checks.map((id,i)=>JSON.stringify({mode:c.mode,id,index:i+1}))).join('\n')+'\n');
 const rehash=()=>fs.writeFileSync(path.join(dir,'FILES.json'),JSON.stringify(['source-before.json','source-after.json','result.json','steps.ndjson'].sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(dir,p)))}))));rehash();
 const check=(optimize=false)=>spawnSync('python3',[...(optimize?['-O']:[]),'-I',path.resolve(import.meta.dirname,'../check-failure-evidence.py'),'--directory',dir,'--expect-commit',pins.expectedCommit,'--expect-tree',pins.expectedTree],{encoding:'utf8',timeout:10000});
 return {dir,rehash,check};
}
test('Independent Python checks the synthetic fixture, including under -O',t=>{const f=filesFixture(t);for(const o of [false,true]){const r=f.check(o);assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).passed,true);}});
for(const [name,change] of [
 ['altered log',f=>fs.appendFileSync(path.join(f.dir,'steps.ndjson'),'{}\n')],
 ['rehash cannot legitimize missing steps',f=>{fs.writeFileSync(path.join(f.dir,'steps.ndjson'),'');f.rehash();}],
 ['duplicate JSON keys',f=>{fs.writeFileSync(path.join(f.dir,'result.json'),'{"status":"failed","status":"passed"}');f.rehash();}],
 ['extra file',f=>fs.writeFileSync(path.join(f.dir,'private.txt'),'not allowed')],
 ['corrupt amount after rehash',f=>{const p=path.join(f.dir,'result.json'),r=JSON.parse(fs.readFileSync(p));r.cases[0].afterFailure.gas=r.cases[0].beforeFailure.gas;fs.writeFileSync(p,JSON.stringify(r));f.rehash();}],
 ['symlink manifest',f=>{const p=path.join(f.dir,'FILES.json');fs.renameSync(p,p+'.old');fs.symlinkSync('FILES.json.old',p);}],
 ['unknown flag',f=>{const p=path.join(f.dir,'result.json'),r=JSON.parse(fs.readFileSync(p));r.stateProofVerified=true;fs.writeFileSync(p,JSON.stringify(r));f.rehash();}]
])test('Python fail-closed: '+name,t=>{const f=filesFixture(t);change(f);for(const o of [false,true])assert.equal(f.check(o).status,1);});
