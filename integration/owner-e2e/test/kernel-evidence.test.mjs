import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {KERNEL_SCHEMA,KERNEL_CHECKS,verifyKernelEvidence} from '../kernel-protocol.mjs';import {BOUNDARIES} from '../crash-protocol.mjs';
const commit='a'.repeat(40),tree='b'.repeat(40),digest='c'.repeat(64);
function example(){return {schema:KERNEL_SCHEMA,status:'passed',mode:'kernel-lease-candidate',commit,tree,sourceStable:true,referenceProduct:'INJ12',productSuccessor:false,publicNetwork:false,productionReady:false,wholeProductAcceptance:false,browserEndToEndPassed:false,checkpointCompatibilityVerified:false,powerLossTested:false,stateProofVerified:false,ownerSubmissions:1,forcedCrashes:2,checkCount:38,cases:BOUNDARIES.map((boundary,i)=>{
 const h=(i?'B':'A').repeat(64),included=i===1,receipt=included?{hash:h,code:0,height:'15',gasUsed:'200000',gasWanted:'1000000'}:null;
 return {boundary,checks:[...KERNEL_CHECKS],requestHash:h,exit:{code:null,signal:'SIGKILL'},httpResult:'connection-lost',
 marker:{schema:'realdex.owner-kernel-marker.v1',boundary,requestHash:h,recordState:'broadcast-unknown',recordReason:'SUBMISSION_STARTING',transportCalls:i,included:receipt,ciphertextSha256:digest,signedSha256:digest,publicNetwork:false,productionReady:false,lockInode:10+i,directoryInode:20+i},
 legacyModeRejected:true,kernelBusyRejected:true,lockFileUnlinked:false,vaultCopied:false,sameHomeRecovered:true,lockInodeBefore:10+i,lockInodeAfter:10+i,directoryInodeBefore:20+i,directoryInodeAfter:20+i,ciphertextSha256:digest,reopenedCipherSha256:digest,signedSha256:digest,restoredSignedSha256:digest,oldPid:12+i,newPid:30+i,tokenChanged:true,oldTokenStatus:401,restoredState:'broadcast-unknown',restoredReason:'SUBMISSION_STARTING',records:1,resubmitError:'INJECTIVE_RESUBMISSION_FORBIDDEN',newApprovalError:'INJECTIVE_UNRESOLVED_TRANSACTION',transportCalls:i,restartedTransportCalls:0,finalState:included?'reported-confirmed':'broadcast-unknown',lookupStatus:included?200:404,amountAtomic:'1000000000000000000',feeAtomic:'500000000000000',before:{sequence:'0',base:'2000000000000000000',gas:'1000000000000000',exchangeBase:'0'},after:{sequence:String(i),base:included?'1000000000000000000':'2000000000000000000',gas:included?'500000000000000':'1000000000000000',exchangeBase:included?'1000000000000000000':'0'},receipt};})};}
const verify=r=>verifyKernelEvidence(r,{expectedCommit:commit,expectedTree:tree});
test('Synthetic candidate receipt requires distinct same-directory scope',()=>assert.equal(verify(example()),true));
for(const [name,change] of Object.entries({
 'old copy scope':r=>{r.schema='realdex.owner-crash-e2e.v1'},
 'missing case':r=>r.cases.pop(),
 'lock removed':r=>r.cases[0].lockFileUnlinked=true,
 'Vault copied':r=>r.cases[0].vaultCopied=true,
 'different directory':r=>r.cases[0].directoryInodeAfter++,
 'different lock':r=>r.cases[0].lockInodeAfter++,
 'missing live-writer test':r=>r.cases[0].kernelBusyRejected=false,
 'legacy mode accepted':r=>r.cases[0].legacyModeRejected=false,
 'wrong old token':r=>r.cases[0].oldTokenStatus=200,
 'changed ciphertext':r=>r.cases[0].reopenedCipherSha256='d'.repeat(64),
 'signed data changed':r=>r.cases[0].restoredSignedSha256='d'.repeat(64),
 'resent after restart':r=>r.cases[1].restartedTransportCalls=1,
 'not-found unlocked':r=>r.cases[0].finalState='reported-confirmed',
 'amount wrong':r=>r.cases[1].after.exchangeBase='999999999999999999',
 'fee wrong':r=>r.cases[1].after.gas='499999999999999',
 'checkpoint certified':r=>r.checkpointCompatibilityVerified=true,
 'latest product certified':r=>r.productSuccessor=true,
 'power loss certified':r=>r.powerLossTested=true,
 'missing check':r=>r.cases[0].checks.pop()
}))test('Candidate evidence rejects '+name,()=>{const r=example();change(r);assert.throws(()=>verify(r));});
const H=b=>createHash('sha256').update(b).digest('hex');
function evidence(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e08-evidence-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const files=[{path:'sample.mjs',bytes:0,mode:'100644',sha256:H('')}],snap={commit,tree,files,digest:H(JSON.stringify(files)),trackedFiles:1};
 const r={...example(),sourceDigest:snap.digest};
 const put=(name,b)=>fs.writeFileSync(path.join(dir,name),b);put('source-before.json',JSON.stringify(snap));put('source-after.json',JSON.stringify(snap));put('result.json',JSON.stringify(r));
 put('steps.ndjson',r.cases.flatMap(c=>c.checks.map((id,i)=>JSON.stringify({boundary:c.boundary,id,index:i+1}))).join('\n')+'\n');
 const rehash=()=>put('FILES.json',JSON.stringify(['source-before.json','source-after.json','result.json','steps.ndjson'].map(p=>({path:p,sha256:H(fs.readFileSync(path.join(dir,p)))}))));rehash();return {dir,r,put,rehash};
}
function checker(d,optimized=false){return spawnSync('python3',['-I',...(optimized?['-O']:[]),path.resolve(import.meta.dirname,'../check-kernel-evidence.py'),'--directory',d,'--expect-commit',commit,'--expect-tree',tree],{encoding:'utf8',timeout:5000});}
test('Independent Python recalculates same-directory and asset/fee conditions',t=>{const f=evidence(t),r=checker(f.dir);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).checks,38);});
for(const [name,change] of Object.entries({
 'modified result plus new hashes':f=>{f.r.cases[0].vaultCopied=true;f.put('result.json',JSON.stringify(f.r));f.rehash();},
 'different inode plus new hashes':f=>{f.r.cases[1].lockInodeAfter++;f.put('result.json',JSON.stringify(f.r));f.rehash();},
 'boolean counter':f=>{f.r.ownerSubmissions=true;f.put('result.json',JSON.stringify(f.r));f.rehash();},
 'missing steps plus new hashes':f=>{f.put('steps.ndjson','');f.rehash();},
 'duplicate JSON key':f=>{f.put('result.json',JSON.stringify(f.r).replace('"status":"passed"','"status":"failed","status":"passed"'));f.rehash();}
}))test('Independent checker fails closed even with -O: '+name,t=>{const f=evidence(t);change(f);const r=checker(f.dir,true);assert.equal(r.status,1,r.stderr);assert.equal(JSON.parse(r.stdout).passed,false);});
