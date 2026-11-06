import {createHash} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {Barrier,fixtureHome,verifyConcurrencyEvidence,FALSE_FLAGS,TOTAL_CHECKS} from '../concurrency-protocol.mjs';import {parseConcurrencyArgs} from '../run-concurrency.mjs';import {fixture,PIN} from './concurrency-fixture.mjs';
test('Synthetic reference record satisfies all five fixed scenarios, without claiming live execution',()=>{assert.equal(TOTAL_CHECKS,55);assert.equal(verifyConcurrencyEvidence(fixture(),PIN),true);});
export const changes={
 'unexpected raw result':r=>{r.ownerToken='synthetic-not-secret';},
 'wrong head':r=>{r.commit='f'.repeat(40);},'wrong tree':r=>{r.tree='f'.repeat(40);},'false pass':r=>{r.status='failed';},'changed source':r=>{r.sourceStable=false;},'substituted product':r=>{r.referenceProduct='INJ13';},
 'missing case':r=>{r.cases.pop();},'duplicate case':r=>{r.cases[1]=r.cases[0];},'reordered case':r=>{r.cases.reverse();},'missing check':r=>{r.cases[0].checks.pop();},
 'extra approval write':r=>{r.cases[0].details.approvalWrites=2;},'signature omitted':r=>{r.cases[0].details.approvalWrites=0;},'signed before release':r=>{r.cases[0].details.approvalSends=1;},
 'missing duplicate':r=>{r.cases[0].details.approvalBusy.pop();},'false duplicate failure':r=>{r.cases[0].details.submitBusy[0].error='RPC_ERROR';},'wrong rejection HTTP':r=>{r.cases[0].details.approvalBusy[0].status=500;},
 'starting state omitted':r=>{r.cases[0].details.startingState='signed';},'missing durable intent':r=>{r.cases[0].details.startingWrites=0;},'network before persistence':r=>{r.cases[0].details.startingSends=1;},
 'duplicate causes query':r=>{r.cases[0].details.duplicateQueryDelta=1;},'duplicate causes save':r=>{r.cases[0].details.duplicateWriteDelta=1;},
 'lock not successful':r=>{r.cases[1].details.lockStatus=500;},'approval signs after lock':r=>{r.cases[1].records=1;},'lock hides other error':r=>{r.cases[1].details.operationError='INVALID_SIGNATURE';},
 'interruption modifies ciphertext':r=>{r.cases[2].details.ciphertextPreserved=false;},'interruption saves':r=>{r.cases[2].details.interruptedWriteDelta=1;},'interruption sends':r=>{r.cases[2].details.interruptedSends=1;},
 'automatic successor':r=>{r.cases[2].details.explicitSendAfterUnlock=false;},'lost signed bytes':r=>{r.cases[2].restoredSignedSha256='d'.repeat(64);},
 'late lock unconsumes sequence':r=>{r.cases[3].after.sequence=r.cases[3].before.sequence;},'late lock missing checktx':r=>{r.cases[3].details.acceptedCode=1;},
 'restart resends':r=>{r.cases[3].details.restartedSends=1;},'old token usable':r=>{r.cases[3].details.oldTokenStatus=200;},'stale process reused':r=>{r.cases[3].details.pidChanged=false;},
 'fixture copy hidden':r=>{r.cases[3].details.copiedVault=true;},'not same home':r=>{r.cases[3].details.sameHome=false;},'abnormal exit':r=>{r.cases[3].details.exit.signal='SIGKILL';},
 'disconnect not confirmed':r=>{r.cases[4].details.clientAborted=false;},'server not finished':r=>{r.cases[4].details.serverFinished=false;},'disconnected auto-send':r=>{r.cases[4].details.explicitSubmit=false;},
 'fee refund':r=>{r.cases[0].after.gas=r.cases[0].before.gas;},'double fee':r=>{r.cases[0].after.gas=String(BigInt(r.cases[0].after.gas)-500000000000000n);},
 'wrong exchange amount':r=>{r.cases[0].after.exchangeBase='1';},'invalid numeric string':r=>{r.cases[0].before.sequence='01';},'floating point sequence':r=>{r.cases[0].after.sequence=9007199254740996;},
 'wrong transaction':r=>{r.cases[2].hash=r.cases[0].hash;},'unsigned receipt':r=>{r.cases[0].hash=null;},'unexpected field leaks':r=>{r.cases[0].token='fake';},
 'terminal query':r=>{r.cases[2].reconcileQueryDelta=1;},'terminal save':r=>{r.cases[2].reconcileWriteDelta=1;},'extra sends':r=>{r.ownerSubmissions=5;},'nonlocal calls':r=>{r.externalRequests=1;},'synthetic response':r=>{r.syntheticResponses=1;},
 ...Object.fromEntries(FALSE_FLAGS.map(k=>[k+' promoted',r=>{r[k]=true;}]))
};
for(const [name,mutate]of Object.entries(changes))test('Evidence rejects '+name,()=>{const r=fixture();mutate(r);assert.throws(()=>verifyConcurrencyEvidence(r,PIN));});
for(const flag of [null,{},'anything'])test('Missing explicit source pins rejected '+JSON.stringify(flag),()=>assert.throws(()=>verifyConcurrencyEvidence(fixture(),flag??{})));
test('Independent Python accepts only the valid synthetic vector, even with -O',()=>{
 const filename=fileURLToPath(new URL('../check-concurrency-evidence.py',import.meta.url));const vectors=[fixture(),...Object.values(changes).map(f=>{const x=fixture();f(x);return x;})];
 const code="import importlib.util,json,sys\nsys.dont_write_bytecode=True\ns=importlib.util.spec_from_file_location('verifier',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nresults=[]\nfor x in json.load(sys.stdin):\n try:m.check_result(x,'a'*40,'b'*40);results.append(True)\n except Exception:results.append(False)\nprint(json.dumps(results))";
 const r=spawnSync('python3',['-I','-O','-c',code,filename],{input:JSON.stringify(vectors),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),vectors.map((_,i)=>i===0));
});
test('A barrier holds only the specified event and releases on its exact ID',async()=>{const b=new Barrier();b.arm({id:1,point:'simulate'});assert.equal(b.matches('submit'),false);let done=false;const p=b.hit('simulate',{state:'signed'}).then(()=>done=true);assert.equal(b.snapshot().reached,true);assert.equal(done,false);assert.throws(()=>b.release({id:2}),/RELEASE/);b.release({id:1});await p;assert.equal(done,true);assert.equal(b.snapshot(),null);b.arm({id:2,point:'response'});b.close();assert.equal(b.snapshot(),null);});
test('Barrier timeout is a failure, not an automatic successful release',async()=>{const b=new Barrier({timeoutMs:10});b.arm({id:1,point:'submit'});await assert.rejects(b.hit('submit',{}),/GATE_TIMEOUT/);assert.equal(b.snapshot(),null);});
test('Closing a held barrier rejects and preserves no successful completion',async()=>{const b=new Barrier();b.arm({id:1,point:'response'});const p=b.hit('response',{});b.close();await assert.rejects(p,/GATE_CLOSED/);assert.throws(()=>b.arm({id:2,point:'response'}),/ARM/);});
test('Barrier metadata is copied, not an externally mutable approval',async()=>{const b=new Barrier(),d={state:'signed'};b.arm({id:1,point:'submit'});const p=b.hit('submit',d);d.state='other';const s=b.snapshot();s.detail.state='changed';assert.equal(b.snapshot().detail.state,'signed');b.release({id:1});await p;});
for(const p of [{id:0,point:'simulate'},{id:1,point:'send-remote'},{id:1,point:'simulate',url:'x'},{id:2,point:'response'}])test('Barrier refuses malformed or skipped arm '+JSON.stringify(p),()=>assert.throws(()=>new Barrier().arm(p)));
test('A second arm or premature/duplicate release is refused',async()=>{const b=new Barrier();b.arm({id:1,point:'submit'});assert.throws(()=>b.arm({id:2,point:'simulate'}));assert.throws(()=>b.release({id:1}));const p=b.hit('submit',{});b.release({id:1});assert.throws(()=>b.release({id:1}));await p;});
for(const timeoutMs of [0,NaN,5001,1.5])test('Unbounded barrier timer refused '+timeoutMs,()=>assert.throws(()=>new Barrier({timeoutMs})));
test('Runner accepts only exact local execution arguments',()=>{assert.deepEqual(parseConcurrencyArgs(['--runtime-dir','a','--output','b','--expect-commit','c','--expect-tree','d']),{runtime:'a',output:'b',expectedCommit:'c',expectedTree:'d'});for(const a of [[],['--output','x'],['--broadcast','yes'],['--runtime-dir','a','--runtime-dir','b']])assert.throws(()=>parseConcurrencyArgs(a));});
test('Private new fixture home accepted; broad, symbolic and permissive homes refused',t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-e2e04-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));assert.equal(fixtureHome(p),p);assert.throws(()=>fixtureHome(os.tmpdir()));fs.chmodSync(p,0o755);assert.throws(()=>fixtureHome(p));fs.chmodSync(p,0o700);const q=p+'-link';fs.symlinkSync(p,q);t.after(()=>fs.rmSync(q,{force:true}));assert.throws(()=>fixtureHome(q));});
// Packaging evidence is independently checked, not accepted on a top-level passed flag.
const py=fileURLToPath(new URL('../check-concurrency-evidence.py',import.meta.url));
const digest=x=>createHash('sha256').update(x).digest('hex');
function evidenceDir(t){
 const p=fs.mkdtempSync(path.join(os.tmpdir(),'e2e04-checker-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));
 const files=[{path:'synthetic.txt',bytes:1,mode:'100644',sha256:digest('x')}];const source={commit:PIN.expectedCommit,tree:PIN.expectedTree,files,digest:digest(JSON.stringify(files)),trackedFiles:1};
 const r={...fixture(),createdAt:'2026-09-07T00:00:00.000Z',durationMs:1,sourceDigest:source.digest,trackedFiles:1,nodeVersion:'synthetic'};
 for(const name of ['source-before.json','source-after.json'])fs.writeFileSync(path.join(p,name),JSON.stringify(source));
 fs.writeFileSync(path.join(p,'result.json'),JSON.stringify(r));fs.writeFileSync(path.join(p,'steps.ndjson'),r.cases.flatMap(c=>c.checks.map((id,i)=>JSON.stringify({mode:c.mode,id,index:i+1}))).join('\n')+'\n');reseal(p);return p;
}
function reseal(p){fs.writeFileSync(path.join(p,'FILES.json'),JSON.stringify(['result.json','source-after.json','source-before.json','steps.ndjson'].map(name=>({path:name,sha256:digest(fs.readFileSync(path.join(p,name)))}))));}
function edit(p,name,fn){const file=path.join(p,name),v=JSON.parse(fs.readFileSync(file));fn(v);fs.writeFileSync(file,JSON.stringify(v));}
function checkDirectory(p){return spawnSync('python3',['-I','-O',py,'--directory',p,'--expect-commit',PIN.expectedCommit,'--expect-tree',PIN.expectedTree],{encoding:'utf8',timeout:10000});}
test('Complete synthetic evidence bundle is accepted without writing extra files',t=>{const p=evidenceDir(t),before=fs.readdirSync(p).sort();const r=checkDirectory(p);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).checks,55);assert.deepEqual(fs.readdirSync(p).sort(),before);});
for(const [name,mutate]of Object.entries({
 'altered raw file':p=>fs.appendFileSync(path.join(p,'steps.ndjson'),'{}'),
 'missing file':p=>fs.unlinkSync(path.join(p,'result.json')),
 'unexpected file':p=>fs.writeFileSync(path.join(p,'unapproved.log'),'x'),
 'duplicate manifest entry':p=>edit(p,'FILES.json',m=>{m[1]=m[0];}),
 'path traversal manifest':p=>edit(p,'FILES.json',m=>{m[0].path='../result.json';}),
 'rehash cannot forge steps':p=>{fs.writeFileSync(path.join(p,'steps.ndjson'),'{}\n');reseal(p);},
 'rehash cannot forge actual sends':p=>{edit(p,'result.json',r=>{r.cases[0].ownerSends=2;});reseal(p);},
 'rehash cannot disguise source change':p=>{edit(p,'source-after.json',r=>{r.files[0].bytes=2;});reseal(p);},
 'duplicate JSON fields':p=>{const f=path.join(p,'result.json');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('{','{"status":"failed",'));reseal(p);},
 'boolean counters':p=>{edit(p,'result.json',r=>{r.cases[0].ownerSends=true;});reseal(p);},
 'hardlink file':p=>fs.linkSync(path.join(p,'result.json'),path.join(p,'alias')),
 'symlink file':p=>{const f=path.join(p,'result.json'),other=path.join(p,'outside-result');fs.renameSync(f,other);fs.symlinkSync(other,f);}
}))test('Independent directory checker rejects '+name,t=>{const p=evidenceDir(t);mutate(p);const r=checkDirectory(p);assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).passed,false);});
