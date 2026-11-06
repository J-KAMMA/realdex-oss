/** Explicit synthetic positive evidence for validators only, not a live runtime result. */
import {SCHEMA,MODES,CHECKS,FALSE_FLAGS,TOTAL_CHECKS,FEE,AMOUNT} from '../concurrency-protocol.mjs';
export const PIN={expectedCommit:'a'.repeat(40),expectedTree:'b'.repeat(40)};
export function fixture(){
 const busy=n=>Array.from({length:n},()=>({status:400,error:'NON_EVM_OPERATION_BUSY'}));
 const cases=MODES.map((mode,i)=>{
  const n=mode==='lock-approval'?0n:1n,before={base:'1000000000000000000000',gas:'10000000000000000000000',sequence:'9007199254740995',exchangeBase:'0'};
  const after={base:String(BigInt(before.base)-n*BigInt(AMOUNT)),gas:String(BigInt(before.gas)-n*BigInt(FEE)),sequence:String(BigInt(before.sequence)+n),exchangeBase:String(n*BigInt(AMOUNT))};
  let details;
  if(mode==='double-click')details={approvalBusy:busy(8),submitBusy:busy(8),reconcileBusy:busy(1),approvalWrites:1,approvalSends:0,startingWrites:1,startingState:'broadcast-unknown',startingReason:'SUBMISSION_STARTING',startingSends:0,duplicateWriteDelta:0,duplicateQueryDelta:0,lateApprovalError:'NON_EVM_REQUEST_NOT_PENDING'};
  else if(mode==='lock-approval'||mode==='lock-submit')details={lockStatus:200,locked:true,operationError:'VAULT_LOCKED',interruptedWriteDelta:0,interruptedSends:0,ciphertextPreserved:true,stateAfterUnlock:n?'signed':null,oldApprovalError:n?null:'NON_EVM_REQUEST_NOT_PENDING',explicitSendAfterUnlock:Boolean(n)};
  else if(mode==='lock-response')details={lockStatus:200,operationError:'VAULT_LOCKED',acceptedCode:0,unknownState:'broadcast-unknown',unknownReason:'SUBMISSION_STARTING',originalSends:1,restartedSends:0,oldTokenStatus:401,tokenChanged:true,pidChanged:true,exit:{code:0,signal:null},sameHome:true,copiedVault:false,resubmitError:'INJECTIVE_RESUBMISSION_FORBIDDEN',ciphertextPreserved:true};
  else details={clientAborted:true,serverFinished:true,approvalWrites:1,approvalSends:0,oldApprovalError:'NON_EVM_REQUEST_NOT_PENDING',explicitSubmit:true};
  return {mode,checks:[...CHECKS[mode]],before,after,feeAtomic:FEE,amountAtomic:AMOUNT,ownerSends:Number(n),records:Number(n),hash:n?String(i+1).repeat(64):null,signedSha256:n?'c'.repeat(64):null,restoredSignedSha256:n?'c'.repeat(64):null,finalState:n?'reported-confirmed':null,reconcileWriteDelta:n?0:null,reconcileQueryDelta:n?0:null,details};
 });return {schema:SCHEMA,mode:'api-concurrency',commit:PIN.expectedCommit,tree:PIN.expectedTree,status:'passed',sourceStable:true,referenceProduct:'INJ12',cases,ownerSubmissions:4,forcedCrashes:0,checkCount:TOTAL_CHECKS,syntheticResponses:0,externalRequests:0,...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false]))};
}
