import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {CRASH_SCHEMA,CRASH_CHECKS,BOUNDARIES,verifyCrashEvidence,verifyMarker,signedDigest,validateArm,fixtureDirectory,readPrivateFile,writeExclusive} from '../crash-protocol.mjs';
import {parseCrashArgs} from '../run-crash.mjs';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const commit='a'.repeat(40),tree='b'.repeat(40),hash='A'.repeat(64),digest='c'.repeat(64);
function example(){return {schema:CRASH_SCHEMA,status:'passed',mode:'api-crash',commit,tree,sourceStable:true,referenceProduct:'INJ12',productSuccessor:false,publicNetwork:false,productionReady:false,wholeProductAcceptance:false,browserEndToEndPassed:false,checkpointCompatibilityVerified:false,powerLossTested:false,stateProofVerified:false,ownerSubmissions:1,forcedCrashes:2,checkCount:32,cases:BOUNDARIES.map((boundary,i)=>{
 const h=(i?'B':'A').repeat(64),included=i===1,receipt=included?{hash:h,code:0,height:'15',gasUsed:'200000',gasWanted:'1000000'}:null;
 return {boundary,checks:[...CRASH_CHECKS],requestHash:h,exit:{code:null,signal:'SIGKILL'},httpResult:'connection-lost',
 marker:{schema:'realdex.owner-crash-marker.v1',boundary,requestHash:h,recordState:'broadcast-unknown',recordReason:'SUBMISSION_STARTING',transportCalls:i,included:receipt,ciphertextSha256:digest,signedSha256:digest,publicNetwork:false,productionReady:false},
 staleLockRejected:true,staleLockUnchanged:true,sameHomeAutoRecovered:false,fixtureCopyOnly:true,ciphertextSha256:digest,copySha256:digest,signedSha256:digest,restoredSignedSha256:digest,oldPid:12+i,newPid:30+i,tokenChanged:true,oldTokenStatus:401,restoredState:'broadcast-unknown',restoredReason:'SUBMISSION_STARTING',records:1,resubmitError:'INJECTIVE_RESUBMISSION_FORBIDDEN',newApprovalError:'INJECTIVE_UNRESOLVED_TRANSACTION',transportCalls:i,restartedTransportCalls:0,finalState:included?'reported-confirmed':'broadcast-unknown',lookupStatus:included?200:404,amountAtomic:'1000000000000000000',feeAtomic:'500000000000000',before:{sequence:'0',base:'2000000000000000000',gas:'1000000000000000',exchangeBase:'0'},after:{sequence:String(i),base:included?'1000000000000000000':'2000000000000000000',gas:included?'500000000000000':'1000000000000000',exchangeBase:included?'1000000000000000000':'0'},receipt};})};}
const verify=r=>verifyCrashEvidence(r,{expectedCommit:commit,expectedTree:tree});
test('Synthetic evidence validates only the explicit crash/reference scope',()=>assert.equal(verify(example()),true));
for(const [name,change] of Object.entries({
 'missing boundary':r=>r.cases.pop(),
 'reordered boundaries':r=>r.cases.reverse(),
 'missing phase':r=>r.cases[0].checks.pop(),
 'duplicate phase':r=>r.cases[0].checks[1]=r.cases[0].checks[0],
 'wrong source':r=>r.commit='d'.repeat(40),
 'dirty source':r=>r.sourceStable=false,
 'browser claimed':r=>r.browserEndToEndPassed=true,
 'checkpoint claimed':r=>r.checkpointCompatibilityVerified=true,
 'production claimed':r=>r.productionReady=true,
 'power-loss claimed':r=>r.powerLossTested=true,
 'latest-product claimed':r=>r.productSuccessor=true,
 'state-proof claimed':r=>r.stateProofVerified=true,
 'wrong mode':r=>r.mode='browser',
 'missing marker':r=>delete r.cases[0].marker,
 'wrong marker hash':r=>r.cases[0].marker.requestHash='F'.repeat(64),
 'wrong marker boundary':r=>r.cases[0].marker.boundary='after-inclusion',
 'crash before durable start':r=>r.cases[0].marker.recordState='signed',
 'normal exit':r=>r.cases[0].exit={code:0,signal:null},
 'unexpected signal':r=>r.cases[0].exit.signal='SIGTERM',
 'HTTP completion instead of interrupted request':r=>r.cases[0].httpResult='response-returned',
 'stale lock auto-cleared':r=>r.cases[0].staleLockUnchanged=false,
 'production recovery implied':r=>r.cases[0].sameHomeAutoRecovered=true,
 'ciphertext changed':r=>r.cases[0].copySha256='e'.repeat(64),
 'signed record changed':r=>r.cases[0].restoredSignedSha256='e'.repeat(64),
 'old process reused':r=>r.cases[0].newPid=r.cases[0].oldPid,
 'old token accepted':r=>r.cases[0].oldTokenStatus=200,
 'restored unresolved record erased':r=>r.cases[0].records=0,
 'restore mislabeled as unsent':r=>r.cases[0].restoredState='signed',
 'resend allowed':r=>r.cases[0].resubmitError=null,
 'unrelated rejection accepted':r=>r.cases[0].newApprovalError='EXPIRED',
 'before-send actually sent':r=>r.cases[0].transportCalls=1,
 'after-send was not sent':r=>r.cases[1].transportCalls=0,
 'restart resent':r=>r.cases[1].restartedTransportCalls=1,
 'not found cleared':r=>r.cases[0].finalState='reported-confirmed',
 'inclusion ignored':r=>r.cases[1].finalState='broadcast-unknown',
 'wrong lookup status':r=>r.cases[1].lookupStatus=404,
 'sequence advanced twice':r=>r.cases[1].after.sequence='2',
 'one atom excessive gas':r=>r.cases[1].after.gas='499999999999999',
 'one atom missing deposit':r=>r.cases[1].after.exchangeBase='999999999999999999',
 'wrong receipt hash':r=>r.cases[1].receipt.hash='F'.repeat(64),
 'receipt execution failure':r=>r.cases[1].receipt.code=1,
 'gas cap exceeded':r=>r.cases[1].marker.included.gasUsed='1000001',
 'fake total':r=>r.checkCount=33,
 'not a fresh account':r=>{r.cases[0].before.sequence='1';r.cases[0].after.sequence='1';},
 'divergent reported gas':r=>{r.cases[1].receipt={...r.cases[1].receipt,gasUsed:'200001'};},
 'missing safety flag':r=>delete r.stateProofVerified
}))test('Reject corrupted crash evidence: '+name,()=>{const r=example();change(r);assert.throws(()=>verify(r));});
for(const bad of [null,{}, {boundary:'after-inclusion',requestHash:hash,extra:true},{boundary:'arbitrary',requestHash:hash},{boundary:'before-request',requestHash:hash.toLowerCase()}])test('Arming rejects malformed fixed-boundary input '+JSON.stringify(bad),()=>assert.throws(()=>validateArm(bad)));
test('Both explicitly named boundaries can be armed',()=>{for(const boundary of BOUNDARIES)assert.equal(validateArm({boundary,requestHash:hash}).boundary,boundary);});
test('CLI refuses external/user-source modes and incomplete pins',()=>{
 for(const args of [[],['--mode','browser'],['--runtime-dir','x','--output','y'],['--runtime-dir','x','--output','y','--expect-commit',commit,'--expect-tree',tree,'--output','z']])assert.throws(()=>parseCrashArgs(args));
 assert.equal(parseCrashArgs(['--runtime-dir','x','--output','y','--expect-commit',commit,'--expect-tree',tree]).expectedCommit,commit);
});
function home(t){const h=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-e2e02-'));t.after(()=>fs.rmSync(h,{recursive:true,force:true}));return h;}
test('Fixture home must be a private explicitly-named system temporary directory',t=>{const h=home(t);assert.equal(fixtureDirectory(h),h);fs.chmodSync(h,0o755);assert.throws(()=>fixtureDirectory(h));});
test('Nested and symlink fixture directories are rejected',t=>{const h=home(t);const p=path.join(h,'realdex-e2e02-child');fs.mkdirSync(p,{mode:0o700});assert.throws(()=>fixtureDirectory(p));const l=h+'-link';fs.symlinkSync(h,l);t.after(()=>fs.unlinkSync(l));assert.throws(()=>fixtureDirectory(l));});
test('Fixture file operations preserve exact ciphertext and refuse overwrites',t=>{const h=home(t),p=path.join(h,'data');writeExclusive(p,Buffer.from('ciphertext'));assert.equal(readPrivateFile(p).toString(),'ciphertext');assert.throws(()=>writeExclusive(p,Buffer.from('replacement')));assert.equal(readPrivateFile(p).toString(),'ciphertext');});
test('Fixture reader rejects hardlinks, symlinks, oversized and public files',t=>{const h=home(t),p=path.join(h,'data');writeExclusive(p,'bytes');assert.throws(()=>readPrivateFile(p,1));fs.chmodSync(p,0o644);assert.throws(()=>readPrivateFile(p));fs.chmodSync(p,0o600);fs.symlinkSync(p,path.join(h,'sym'));assert.throws(()=>readPrivateFile(path.join(h,'sym')));fs.linkSync(p,path.join(h,'hard'));assert.throws(()=>readPrivateFile(p));});

test('Signed record digest survives Vault key sorting but not changed transaction bytes',()=>{
 const a={requestId:'A'.repeat(64),txRawBase64:'AQID',metadata:{z:'value',a:'1'}};
 const b={metadata:{a:'1',z:'value'},txRawBase64:'AQID',requestId:'A'.repeat(64)};
 assert.equal(signedDigest(a),signedDigest(b));
 assert.notEqual(signedDigest(a),signedDigest({...b,txRawBase64:'AQIE'}));
 assert.notEqual(signedDigest(a),signedDigest({...b,metadata:{a:'2',z:'value'}}));
});

const H=b=>createHash('sha256').update(b).digest('hex');
function syntheticEvidence(t){
 const dir=home(t),files=[{path:'probe.mjs',bytes:0,mode:'100644',sha256:H('')}],snapshot={commit,tree,files,digest:H(JSON.stringify(files)),trackedFiles:1};
 const r={...example(),sourceDigest:snapshot.digest},steps=r.cases.flatMap(c=>c.checks.map((id,i)=>({boundary:c.boundary,id,index:i+1})));
 const put=(name,data)=>fs.writeFileSync(path.join(dir,name),data,{mode:0o600});
 put('source-before.json',JSON.stringify(snapshot));put('source-after.json',JSON.stringify(snapshot));put('result.json',JSON.stringify(r));put('steps.ndjson',steps.map(x=>JSON.stringify(x)).join('\n')+'\n');
 const rehash=()=>put('FILES.json',JSON.stringify(['result.json','source-after.json','source-before.json','steps.ndjson'].map(p=>({path:p,sha256:H(fs.readFileSync(path.join(dir,p)))}))));rehash();
 return {dir,put,rehash,r};
}
const checker=fileURLToPath(new URL('../check-crash-evidence.py',import.meta.url));
function pythonCheck(dir,flags=[]){return spawnSync('python3',['-I',...flags,checker,'--directory',dir,'--expect-commit',commit,'--expect-tree',tree],{encoding:'utf8',timeout:10000,maxBuffer:1048576});}
test('Independent Python verifies synthetic accounting and hashes without claiming actual execution',t=>{const f=syntheticEvidence(t),p=pythonCheck(f.dir);assert.equal(p.status,0,p.stderr);const r=JSON.parse(p.stdout);assert.equal(r.passed,true);assert.equal(r.checkpointCompatibilityVerified,false);});
for(const [name,mutate] of Object.entries({
 'altered raw evidence':f=>f.put('result.json','{}'),
 'missing file':f=>fs.unlinkSync(path.join(f.dir,'steps.ndjson')),
 'extra file':f=>f.put('unexpected.txt','x'),
 'changed steps and new checksum':f=>{f.put('steps.ndjson','');f.rehash();},
 'false result with new checksum':f=>{f.r.status='failed';f.put('result.json',JSON.stringify(f.r));f.rehash();},
 'unknown source with new checksum':f=>{f.r.commit='e'.repeat(40);f.put('result.json',JSON.stringify(f.r));f.rehash();},
 'duplicate JSON keys with new checksum':f=>{f.put('result.json',JSON.stringify(f.r).replace('"status":"passed"','"status":"failed","status":"passed"'));f.rehash();},
 'boolean count with new checksum':f=>{f.r.ownerSubmissions=true;f.put('result.json',JSON.stringify(f.r));f.rehash();},
 'symbolic evidence file':f=>{const p=path.join(f.dir,'result.json');fs.renameSync(p,p+'.original');fs.symlinkSync('result.json.original',p);},
 'traversal manifest entry':f=>{const p=path.join(f.dir,'FILES.json'),v=JSON.parse(fs.readFileSync(p));v[0].path='../result.json';f.put('FILES.json',JSON.stringify(v));}
}))test('Independent Python fails closed: '+name,t=>{const f=syntheticEvidence(t);mutate(f);const p=pythonCheck(f.dir);assert.equal(p.status,1,p.stderr);assert.equal(JSON.parse(p.stdout).passed,false);});
test('Python optimized mode cannot disable the independent validation conditions',t=>{const f=syntheticEvidence(t);f.r.cases[1].restartedTransportCalls=1;f.put('result.json',JSON.stringify(f.r));f.rehash();const p=pythonCheck(f.dir,['-O']);assert.equal(p.status,1,p.stderr);});
