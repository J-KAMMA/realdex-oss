/** E2E-02 fixed crash boundaries. A test receipt is not independent chain/OS evidence. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {need,sha,uint} from './protocol.mjs';
import {canonical} from '../../wallet/lib/guard.mjs';
export const CRASH_SCHEMA='realdex.owner-crash-e2e.v1';
export const BOUNDARIES=Object.freeze(['before-request','after-inclusion']);
export const CRASH_CHECKS=Object.freeze(['fresh-owner','review-bound','signed-no-send','crash-marker-bound',
 'sigkill-confirmed','stale-lock-preserved','ciphertext-copied-exactly','new-process-new-token',
 'old-token-rejected','exact-record-restored','resubmit-rejected','unresolved-blocks-new-approval',
 'chain-outcome-matches-boundary','stored-hash-reconciled','no-restart-send','exact-accounting']);
// Vault encryption canonicalizes object-key order; compare exact values, not insertion order.
export const signedDigest=s=>sha(canonical(s));
export function validateArm(p){
 need(p&&Object.keys(p).length===2&&BOUNDARIES.includes(p.boundary)&&typeof p.requestHash==='string'&&/^[A-F0-9]{64}$/.test(p.requestHash),'E2E_CRASH_ARM_INVALID');return p;
}
export function fixtureDirectory(directory){
 need(process.platform==='linux'&&typeof directory==='string','E2E_CRASH_LINUX_FIXTURE_REQUIRED');
 const p=path.resolve(directory),s=fs.lstatSync(p);
 need(p===directory&&path.dirname(p)===fs.realpathSync(os.tmpdir())&&path.basename(p).startsWith('realdex-e2e02-')&&s.isDirectory()&&!s.isSymbolicLink()&&fs.realpathSync(p)===p&&s.uid===process.getuid()&&(s.mode&0o077)===0,'E2E_CRASH_FIXTURE_DIRECTORY');return p;
}
export function readPrivateFile(file,maximum=1048576){
 const s=fs.lstatSync(file);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size>0&&s.size<=maximum&&s.uid===process.getuid()&&(s.mode&0o077)===0,'E2E_CRASH_PRIVATE_FILE');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const a=fs.fstatSync(fd);need(a.dev===s.dev&&a.ino===s.ino&&a.size===s.size,'E2E_CRASH_FILE_CHANGED');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
export function writeExclusive(file,data){
 const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export function verifyMarker(m,boundary,hash){
 validateArm({boundary,requestHash:hash});
 need(m?.schema==='realdex.owner-crash-marker.v1'&&m.boundary===boundary&&m.requestHash===hash,'E2E_CRASH_MARKER_IDENTITY');
 need(m.recordState==='broadcast-unknown'&&m.recordReason==='SUBMISSION_STARTING'&&m.transportCalls===(boundary==='after-inclusion'?1:0),'E2E_CRASH_MARKER_BOUNDARY');
 need(m.publicNetwork===false&&m.productionReady===false&&/^[a-f0-9]{64}$/.test(m.ciphertextSha256)&&/^[a-f0-9]{64}$/.test(m.signedSha256),'E2E_CRASH_MARKER_DIGEST');
 if(boundary==='before-request')need(m.included===null,'E2E_CRASH_MARKER_RECEIPT');
 else need(m.included?.hash===hash&&m.included.code===0&&uint(m.included.height)>0n&&uint(m.included.gasUsed)>0n&&uint(m.included.gasUsed)<=uint(m.included.gasWanted),'E2E_CRASH_MARKER_RECEIPT');
 return true;
}
export function verifyCrashEvidence(r,{expectedCommit,expectedTree}={}){
 need(/^[a-f0-9]{40}$/.test(expectedCommit??'')&&/^[a-f0-9]{40}$/.test(expectedTree??'')&&r?.commit===expectedCommit&&r.tree===expectedTree,'E2E_CRASH_SOURCE_IDENTITY');
 need(r.schema===CRASH_SCHEMA&&r.status==='passed'&&r.mode==='api-crash'&&r.sourceStable===true,'E2E_CRASH_STATUS');
 for(const k of ['publicNetwork','productionReady','wholeProductAcceptance','browserEndToEndPassed','checkpointCompatibilityVerified','powerLossTested','stateProofVerified'])need(r[k]===false,'E2E_CRASH_APPROVAL');
 need(r.referenceProduct==='INJ12'&&r.productSuccessor===false,'E2E_CRASH_REFERENCE_SCOPE');
 need(r.cases?.length===2&&r.cases.every((c,i)=>c.boundary===BOUNDARIES[i]),'E2E_CRASH_CASE_SET');
 const hashes=new Set();
 for(const c of r.cases){
  need(c.checks?.length===CRASH_CHECKS.length&&CRASH_CHECKS.every((s,i)=>c.checks[i]===s),'E2E_CRASH_CHECK_SET');
  const included=c.boundary==='after-inclusion';verifyMarker(c.marker,c.boundary,c.requestHash);
  need(!hashes.has(c.requestHash),'E2E_CRASH_DUPLICATE_HASH');hashes.add(c.requestHash);
  need(c.exit?.code===null&&c.exit.signal==='SIGKILL'&&c.httpResult==='connection-lost','E2E_CRASH_UNEXPECTED_EXIT');
  need(c.staleLockRejected===true&&c.staleLockUnchanged===true&&c.sameHomeAutoRecovered===false&&c.fixtureCopyOnly===true,'E2E_CRASH_LOCK_STATE');
  need(c.ciphertextSha256===c.copySha256&&c.ciphertextSha256===c.marker.ciphertextSha256,'E2E_CRASH_CIPHER_IDENTITY');
  need(c.signedSha256===c.restoredSignedSha256&&c.signedSha256===c.marker.signedSha256,'E2E_CRASH_SIGNED_IDENTITY');
  need(c.oldPid!==c.newPid&&Number.isSafeInteger(c.oldPid)&&c.oldPid>0&&Number.isSafeInteger(c.newPid)&&c.newPid>0&&c.oldTokenStatus===401&&c.tokenChanged===true,'E2E_CRASH_RESTART_IDENTITY');
  need(c.restoredState==='broadcast-unknown'&&c.restoredReason==='SUBMISSION_STARTING'&&c.records===1,'E2E_CRASH_RESTORED_STATE');
  need(c.resubmitError==='INJECTIVE_RESUBMISSION_FORBIDDEN'&&c.newApprovalError==='INJECTIVE_UNRESOLVED_TRANSACTION','E2E_CRASH_REJECTION');
  need(c.transportCalls===(included?1:0)&&c.restartedTransportCalls===0,'E2E_CRASH_SEND_COUNTS');
  need(c.finalState===(included?'reported-confirmed':'broadcast-unknown')&&c.lookupStatus===(included?200:404),'E2E_CRASH_FINAL_STATE');
  need(c.before.sequence==='0'&&c.before.exchangeBase==='0','E2E_CRASH_FRESH_OWNER');
  const seqDelta=uint(c.after.sequence)-uint(c.before.sequence),gasDelta=uint(c.before.gas)-uint(c.after.gas),amount=1000000000000000000n;
  need(c.amountAtomic===String(amount)&&c.feeAtomic==='500000000000000','E2E_CRASH_SCENARIO_CONSTANT');
  need(seqDelta===(included?1n:0n)&&gasDelta===(included?500000000000000n:0n),'E2E_CRASH_COST_ACCOUNTING');
  need(uint(c.before.base)-uint(c.after.base)===(included?amount:0n)&&uint(c.before.exchangeBase)===0n&&uint(c.after.exchangeBase)===(included?amount:0n),'E2E_CRASH_ASSET_ACCOUNTING');
  if(included)need(c.receipt?.hash===c.requestHash&&c.receipt.code===0&&c.receipt.height===c.marker.included.height&&c.receipt.gasWanted==='1000000'&&canonical(c.receipt)===canonical(c.marker.included),'E2E_CRASH_CHAIN_RECEIPT');
  else need(c.receipt===null,'E2E_CRASH_CHAIN_RECEIPT');
 }
 need(r.ownerSubmissions===1&&r.forcedCrashes===2&&r.checkCount===32,'E2E_CRASH_TOTAL');return true;
}
