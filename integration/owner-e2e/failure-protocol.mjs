/** Local diagnostic evidence only. Neither self-hashes nor this checker authenticate chain state. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {need,uint} from './protocol.mjs';
export const FAILURE_SCHEMA='realdex.owner-included-failure-e2e.v1';
export const MODES=Object.freeze(['response','kill-before-record']);
export const FAILURE_CHECKS=Object.freeze(['fresh-owner','order-included','cancel-reviewed-signed','before-send-barrier',
 'counterparty-full-fill','unchanged-owner-sequence','one-failed-submission','failure-on-real-chain',
 'restart-boundary-verified','old-session-rejected','exact-unresolved-record','resubmit-rejected',
 'unresolved-blocks-new-approval','failed-receipt-reconciled','failure-has-no-action-effect','failed-tx-costs-retained',
 'terminal-reconcile-idempotent','restart-after-failure-preserves-record','new-owner-approval','successor-included',
 'final-accounting','unique-sends']);
export const FALSE_FLAGS=Object.freeze(['publicNetwork','productionReady','wholeProductAcceptance','browserEndToEndPassed',
 'checkpointCompatibilityVerified','powerLossTested','stateProofVerified','productSuccessor']);
export function exactKeys(p,names,code='E2E_FAILURE_FIELDS'){
 need(p&&typeof p==='object'&&!Array.isArray(p)&&Object.keys(p).length===names.length&&names.every(n=>Object.hasOwn(p,n)),code);return p;
}
export function failureHome(directory){
 need(process.platform==='linux'&&typeof directory==='string','E2E_FAILURE_FIXTURE_HOME');
 const p=path.resolve(directory),s=fs.lstatSync(p);
 need(p===directory&&path.dirname(p)===fs.realpathSync(os.tmpdir())&&/^realdex-e2e03-[A-Za-z0-9_-]+$/.test(path.basename(p))&&s.isDirectory()&&!s.isSymbolicLink()&&fs.realpathSync(p)===p&&s.uid===process.getuid()&&(s.mode&0o077)===0,'E2E_FAILURE_FIXTURE_HOME');return p;
}
export function failureArm(p){exactKeys(p,['mode','requestHash']);need(MODES.includes(p.mode)&&typeof p.requestHash==='string'&&/^[A-F0-9]{64}$/.test(p.requestHash),'E2E_FAILURE_ARM');return p;}
export function releaseGate(p,hash){exactKeys(p,['schema','requestHash']);need(p.schema==='realdex.failure-release.v1'&&p.requestHash===hash,'E2E_FAILURE_RELEASE');return true;}
export function failedReceipt(t,hash){
 need(t?.txhash===hash&&/^[A-F0-9]{64}$/.test(hash)&&Number.isSafeInteger(t.code)&&t.code>0&&t.code<=0xffffffff,'E2E_FAILURE_RECEIPT');
 need(typeof t.codespace==='string'&&/^[a-z][a-z0-9_-]{0,31}$/.test(t.codespace)&&uint(t.height)>0n&&t.gas_wanted==='1000000'&&uint(t.gas_used)>0n&&uint(t.gas_used)<=1000000n,'E2E_FAILURE_RECEIPT');
 return {hash:t.txhash,code:t.code,codespace:t.codespace,height:t.height,gasWanted:t.gas_wanted,gasUsed:t.gas_used};
}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash64=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
function outcome(t,hash){return failedReceipt({txhash:t?.hash,code:t?.code,codespace:t?.codespace,height:t?.height,gas_wanted:t?.gasWanted,gas_used:t?.gasUsed},hash);}
function state(s){need(s&&Object.keys(s).length===6,'E2E_FAILURE_ACCOUNTING');for(const k of ['base','quote','gas','sequence','exchangeBase'])uint(s[k]);need(s.openOrders===0,'E2E_FAILURE_ORDER_REMAINED');}
export function verifyFailureEvidence(r,{expectedCommit,expectedTree}={}){
 need(/^[a-f0-9]{40}$/.test(expectedCommit??'')&&/^[a-f0-9]{40}$/.test(expectedTree??'')&&r?.commit===expectedCommit&&r.tree===expectedTree,'E2E_FAILURE_SOURCE');
 need(r.schema===FAILURE_SCHEMA&&r.status==='passed'&&r.mode==='api-included-failure'&&r.sourceStable===true&&r.referenceProduct==='INJ12','E2E_FAILURE_STATUS');
 for(const k of FALSE_FLAGS)need(r[k]===false,'E2E_FAILURE_APPROVAL');
 need(r.cases?.length===2&&r.cases.every((c,i)=>c.mode===MODES[i]),'E2E_FAILURE_CASES');
 const unique=new Set();
 for(const c of r.cases){
  need(equal(c.checks,FAILURE_CHECKS),'E2E_FAILURE_CHECKS');failureArm({mode:c.mode,requestHash:c.failureHash});
  for(const h of [c.orderHash,c.failureHash,c.counterpartyHash,c.successorHash]){need(typeof h==='string'&&/^[A-F0-9]{64}$/.test(h)&&!unique.has(h),'E2E_FAILURE_HASHES');unique.add(h);}
  const t=outcome(c.receipt,c.failureHash);need(t.codespace==='exchange'&&t.code===19,'E2E_FAILURE_CODESPACE'); // Exact observed error in this pinned missing-order scenario, not any failure.
  need(c.checkTxCode===0&&c.lookupStatus===200&&c.preRaceSequence===c.beforeFailure.sequence,'E2E_FAILURE_CHAIN_OUTCOME');
  need(c.beforeFailure.sequence==='1'&&c.beforeFailure.exchangeBase==='0'&&c.beforeFailure.openOrders===0,'E2E_FAILURE_FRESH_OWNER');
  need(c.failedState==='reported-reverted'&&c.failedReason==='INCLUDED_FAILURE'&&c.failureReceived===true&&c.savedFailureCode===t.code&&c.savedFailureHeight===t.height&&c.actionEffectPresent===false,'E2E_FAILURE_REPORT');
  need(c.automaticRetry===false&&c.finalityProven===false&&c.retirementPresent===false,'E2E_FAILURE_REPORT_AUTHORITY');
  need(c.oldTokenStatus===401&&c.newTokenDistinct===true&&Number.isSafeInteger(c.oldPid)&&c.oldPid>0&&Number.isSafeInteger(c.restartedPid)&&c.restartedPid>0&&c.oldPid!==c.restartedPid,'E2E_FAILURE_SESSION');
  need(c.restoredState===(c.mode==='response'?'broadcast':'broadcast-unknown')&&c.restoredReason===(c.mode==='response'?'RPC_ACCEPTED_NOT_CONFIRMED':'SUBMISSION_STARTING'),'E2E_FAILURE_RESTORE');
  need(hash64(c.signedSha256)&&c.signedSha256===c.restoredSignedSha256&&c.signedSha256===c.finalSignedSha256,'E2E_FAILURE_SIGNED');
  need(c.unresolvedError==='INJECTIVE_UNRESOLVED_TRANSACTION'&&c.resubmitError==='INJECTIVE_RESUBMISSION_FORBIDDEN','E2E_FAILURE_REJECTIONS');
  need(c.firstProcessSends===2&&c.beforeReconcileSends===0&&c.afterReconcileSends===0&&c.successorProcessSends===1&&c.finalRecordCount===3,'E2E_FAILURE_SENDS');
  need(c.reconcileWriteDelta===0&&c.reconcileQueryDelta===0&&c.failurePersistsAfterSecondRestart===true&&c.successorState==='reported-confirmed','E2E_FAILURE_IDEMPOTENCY');
  need(c.feeAtomic==='500000000000000'&&c.successorAmountAtomic==='250000000000000000','E2E_FAILURE_CONSTANTS');
  for(const s of [c.beforeFailure,c.afterFailure,c.afterSuccessor])state(s);
  const b=c.beforeFailure,a=c.afterFailure,z=c.afterSuccessor;
  need(uint(a.sequence)-uint(b.sequence)===1n&&uint(b.gas)-uint(a.gas)===500000000000000n&&a.base===b.base&&a.quote===b.quote&&a.exchangeBase===b.exchangeBase,'E2E_FAILURE_FAILURE_ACCOUNTING');
  need(uint(z.sequence)-uint(a.sequence)===1n&&uint(a.gas)-uint(z.gas)===500000000000000n&&uint(a.base)-uint(z.base)===250000000000000000n&&z.exchangeBase==='250000000000000000'&&z.quote===a.quote,'E2E_FAILURE_SUCCESSOR_ACCOUNTING');
  need(c.barrier.mode===c.mode&&c.barrier.requestHash===c.failureHash&&c.barrier.state==='broadcast-unknown'&&c.barrier.reason==='SUBMISSION_STARTING'&&c.barrier.ownerSends===1&&c.barrier.signedSha256===c.signedSha256,'E2E_FAILURE_BARRIER');
  if(c.mode==='kill-before-record'){
   need(c.exit?.code===null&&c.exit.signal==='SIGKILL'&&c.httpResult==='connection-lost','E2E_FAILURE_CRASH');
   need(c.staleLockPreserved===true&&c.sameHomeAutoRecovered===false&&c.fixtureCopyOnly===true&&hash64(c.ciphertextSha256)&&c.ciphertextSha256===c.copiedCiphertextSha256,'E2E_FAILURE_LOCK');
   const m=c.crashMarker;need(m?.schema==='realdex.failure-crash-marker.v1'&&m.requestHash===c.failureHash&&m.signedSha256===c.signedSha256&&m.ciphertextSha256===c.ciphertextSha256&&m.ownerSends===2&&m.state==='broadcast-unknown'&&m.reason==='SUBMISSION_STARTING'&&equal(outcome(m.receipt,c.failureHash),t),'E2E_FAILURE_CRASH_MARKER');
  }else need(c.exit?.code===0&&c.exit.signal===null&&c.httpResult==='response-returned'&&c.fixtureCopyOnly===false&&c.sameHomeAutoRecovered===false&&c.staleLockPreserved===null&&c.crashMarker===null&&c.ciphertextSha256===null&&c.copiedCiphertextSha256===null,'E2E_FAILURE_GRACEFUL');
 }
 need(r.ownerSubmissions===6&&r.counterpartySubmissions===2&&r.failedIncludedTransactions===2&&r.forcedCrashes===1&&r.checkCount===44,'E2E_FAILURE_TOTALS');return true;
}
