/** Reference-only concurrency evidence and deterministic test barriers. No product authorization. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {need,uint} from './protocol.mjs';
import {exactKeys,FALSE_FLAGS} from './failure-protocol.mjs';
export {FALSE_FLAGS};
export const SCHEMA='realdex.owner-concurrency-e2e.v1';
export const MODES=Object.freeze(['double-click','lock-approval','lock-submit','lock-response','disconnect-approval']);
export const POINTS=Object.freeze(['simulate','submit','response']);
export const FEE='500000000000000',AMOUNT='250000000000000000';
export const CHECKS=Object.freeze({
 'double-click':['owner-ready','approval-held','eight-approvals-busy','one-signature-saved','old-approval-rejected','submission-start-persisted','eight-submits-busy','concurrent-reconcile-busy','one-transaction-included','receipt-saved','terminal-idempotent','final-accounting'],
 'lock-approval':['owner-ready','approval-held','emergency-lock-returned','approval-stopped','no-signature-or-send','unlock-restores-no-record','old-approval-rejected','final-accounting'],
 'lock-submit':['owner-ready','one-signature-saved','submission-recheck-held','emergency-lock-returned','submission-stopped','signed-record-preserved','fresh-explicit-submit','one-transaction-included','receipt-saved','terminal-idempotent','final-accounting'],
 'lock-response':['owner-ready','one-signature-saved','accepted-response-held','one-transaction-included','emergency-lock-returned','response-not-saved','same-home-graceful-restart','old-token-rejected','unknown-record-preserved','resubmit-rejected','receipt-saved','terminal-idempotent','final-accounting'],
 'disconnect-approval':['owner-ready','approval-held','client-disconnected','approval-completed-on-server','one-signature-saved','old-approval-rejected','fresh-explicit-submit','one-transaction-included','receipt-saved','terminal-idempotent','final-accounting']
});
export const TOTAL_CHECKS=Object.values(CHECKS).reduce((n,x)=>n+x.length,0);
export function fixtureHome(value){
 need(process.platform==='linux'&&typeof value==='string','E2E_CONCURRENCY_HOME');const p=path.resolve(value),s=fs.lstatSync(p);
 need(p===value&&path.dirname(p)===fs.realpathSync(os.tmpdir())&&/^realdex-e2e04-[A-Za-z0-9_-]+$/.test(path.basename(p))&&s.isDirectory()&&!s.isSymbolicLink()&&fs.realpathSync(p)===p&&s.uid===process.getuid()&&(s.mode&0o077)===0,'E2E_CONCURRENCY_HOME');return p;
}
/** One bounded barrier, monotone IDs, exact release. A timeout rejects rather than passes. */
export class Barrier {
 constructor({timeoutMs=5000}={}){need(Number.isSafeInteger(timeoutMs)&&timeoutMs>=10&&timeoutMs<=5000,'E2E_CONCURRENCY_BARRIER_LIMIT');this.timeoutMs=timeoutMs;this.next=1;this.active=null;this.closed=false;}
 arm(p){exactKeys(p,['id','point'],'E2E_CONCURRENCY_ARM_FIELDS');need(!this.closed&&!this.active&&p.id===this.next&&POINTS.includes(p.point),'E2E_CONCURRENCY_ARM');this.next++;this.active={id:p.id,point:p.point,reached:false};return {armed:true,id:p.id};}
 matches(point){return this.active?.point===point&&!this.active.reached;}
 async hit(point,detail){need(this.matches(point),'E2E_CONCURRENCY_HIT');const a=this.active;a.reached=true;a.detail=structuredClone(detail);
  try{await new Promise((resolve,reject)=>{a.resolve=resolve;a.reject=reject;a.timer=setTimeout(()=>reject(Error('E2E_CONCURRENCY_GATE_TIMEOUT')),this.timeoutMs);});}
  finally{clearTimeout(a.timer);if(this.active===a)this.active=null;}
 }
 release(p){exactKeys(p,['id'],'E2E_CONCURRENCY_RELEASE_FIELDS');const a=this.active;need(!this.closed&&a?.reached&&p.id===a.id&&!a.released,'E2E_CONCURRENCY_RELEASE');a.released=true;a.resolve();return {released:true,id:p.id};}
 snapshot(){const a=this.active;return a?{id:a.id,point:a.point,reached:a.reached,released:a.released??false,...(a.detail?{detail:structuredClone(a.detail)}:{})}:null;}
 close(){this.closed=true;if(this.active?.reject)this.active.reject(Error('E2E_CONCURRENCY_GATE_CLOSED'));else this.active=null;}
}
const hash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),txhash=s=>typeof s==='string'&&/^[A-F0-9]{64}$/.test(s);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function accounting(s){exactKeys(s,['base','gas','sequence','exchangeBase'],'E2E_CONCURRENCY_ACCOUNTING');for(const v of Object.values(s))uint(v);}
function errorCount(x,count,code){need(Array.isArray(x)&&x.length===count&&x.every(v=>v?.status===400&&v.error===code&&Object.keys(v).length===2),'E2E_CONCURRENCY_REJECTIONS');}
export function verifyConcurrencyEvidence(r,{expectedCommit,expectedTree}={}){
 need(/^[a-f0-9]{40}$/.test(expectedCommit??'')&&/^[a-f0-9]{40}$/.test(expectedTree??'')&&r?.commit===expectedCommit&&r.tree===expectedTree,'E2E_CONCURRENCY_SOURCE');
 need(Object.keys(r).every(k=>['schema','mode','commit','tree','status','sourceStable','referenceProduct','cases','ownerSubmissions','forcedCrashes','checkCount','syntheticResponses','externalRequests',...FALSE_FLAGS,'chainVersion','genesisSha256','createdAt','durationMs','sourceDigest','trackedFiles','nodeVersion'].includes(k)),'E2E_CONCURRENCY_RESULT_FIELDS');
 need(r.schema===SCHEMA&&r.mode==='api-concurrency'&&r.status==='passed'&&r.sourceStable===true&&r.referenceProduct==='INJ12','E2E_CONCURRENCY_STATUS');
 for(const k of FALSE_FLAGS)need(r[k]===false,'E2E_CONCURRENCY_APPROVAL');
 need(Array.isArray(r.cases)&&r.cases.length===5&&r.cases.every((c,i)=>c.mode===MODES[i]),'E2E_CONCURRENCY_CASES');const seen=new Set();
 for(const c of r.cases){
  exactKeys(c,['mode','checks','before','after','feeAtomic','amountAtomic','ownerSends','records','hash','signedSha256','restoredSignedSha256','finalState','reconcileWriteDelta','reconcileQueryDelta','details'],'E2E_CONCURRENCY_CASE_FIELDS');
  need(same(c.checks,CHECKS[c.mode])&&c.feeAtomic===FEE&&c.amountAtomic===AMOUNT,'E2E_CONCURRENCY_CHECKS');accounting(c.before);accounting(c.after);
  const count=c.mode==='lock-approval'?0:1,b=c.before,a=c.after;
  need(c.ownerSends===count&&c.records===count,'E2E_CONCURRENCY_SENDS');
  need(uint(a.sequence)-uint(b.sequence)===BigInt(count)&&uint(b.gas)-uint(a.gas)===BigInt(FEE)*BigInt(count)&&uint(b.base)-uint(a.base)===BigInt(AMOUNT)*BigInt(count)&&uint(a.exchangeBase)-uint(b.exchangeBase)===BigInt(AMOUNT)*BigInt(count),'E2E_CONCURRENCY_ACCOUNTING');
  if(count){need(txhash(c.hash)&&!seen.has(c.hash)&&hash(c.signedSha256)&&c.signedSha256===c.restoredSignedSha256&&c.finalState==='reported-confirmed'&&c.reconcileWriteDelta===0&&c.reconcileQueryDelta===0,'E2E_CONCURRENCY_RECORD');seen.add(c.hash);}
  else need([c.hash,c.signedSha256,c.restoredSignedSha256,c.finalState,c.reconcileWriteDelta,c.reconcileQueryDelta].every(x=>x===null),'E2E_CONCURRENCY_NO_SIGNATURE');
  const d=c.details;
  if(c.mode==='double-click'){
   exactKeys(d,['approvalBusy','submitBusy','reconcileBusy','approvalWrites','approvalSends','startingWrites','startingState','startingReason','startingSends','duplicateWriteDelta','duplicateQueryDelta','lateApprovalError']);
   errorCount(d.approvalBusy,8,'NON_EVM_OPERATION_BUSY');errorCount(d.submitBusy,8,'NON_EVM_OPERATION_BUSY');errorCount(d.reconcileBusy,1,'NON_EVM_OPERATION_BUSY');
   need(d.approvalWrites===1&&d.approvalSends===0&&d.startingWrites===1&&d.startingState==='broadcast-unknown'&&d.startingReason==='SUBMISSION_STARTING'&&d.startingSends===0&&d.duplicateWriteDelta===0&&d.duplicateQueryDelta===0&&d.lateApprovalError==='NON_EVM_REQUEST_NOT_PENDING','E2E_CONCURRENCY_DOUBLE_CLICK');
  }else if(c.mode==='lock-approval'||c.mode==='lock-submit'){
   exactKeys(d,['lockStatus','locked','operationError','interruptedWriteDelta','interruptedSends','ciphertextPreserved','stateAfterUnlock','oldApprovalError','explicitSendAfterUnlock']);
   need(d.lockStatus===200&&d.locked===true&&d.operationError==='VAULT_LOCKED'&&d.interruptedWriteDelta===0&&d.interruptedSends===0&&d.ciphertextPreserved===true,'E2E_CONCURRENCY_LOCK');
   need(d.stateAfterUnlock===(count?'signed':null)&&d.oldApprovalError===(count?null:'NON_EVM_REQUEST_NOT_PENDING')&&d.explicitSendAfterUnlock===Boolean(count),'E2E_CONCURRENCY_UNLOCK');
  }else if(c.mode==='lock-response'){
   exactKeys(d,['lockStatus','operationError','acceptedCode','unknownState','unknownReason','originalSends','restartedSends','oldTokenStatus','tokenChanged','pidChanged','exit','sameHome','copiedVault','resubmitError','ciphertextPreserved']);
   need(d.lockStatus===200&&d.operationError==='VAULT_LOCKED'&&d.acceptedCode===0&&d.unknownState==='broadcast-unknown'&&d.unknownReason==='SUBMISSION_STARTING'&&d.originalSends===1&&d.restartedSends===0&&d.oldTokenStatus===401&&d.tokenChanged===true&&d.pidChanged===true&&same(d.exit,{code:0,signal:null})&&d.sameHome===true&&d.copiedVault===false&&d.resubmitError==='INJECTIVE_RESUBMISSION_FORBIDDEN'&&d.ciphertextPreserved===true,'E2E_CONCURRENCY_IN_FLIGHT');
  }else{
   exactKeys(d,['clientAborted','serverFinished','approvalWrites','approvalSends','oldApprovalError','explicitSubmit']);
   need(d.clientAborted===true&&d.serverFinished===true&&d.approvalWrites===1&&d.approvalSends===0&&d.oldApprovalError==='NON_EVM_REQUEST_NOT_PENDING'&&d.explicitSubmit===true,'E2E_CONCURRENCY_DISCONNECT');
  }
 }
 need(r.ownerSubmissions===4&&r.forcedCrashes===0&&r.checkCount===TOTAL_CHECKS&&r.syntheticResponses===0&&r.externalRequests===0,'E2E_CONCURRENCY_TOTALS');return true;
}
