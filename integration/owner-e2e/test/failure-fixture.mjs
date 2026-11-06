/** SYNTHETIC verifier test vector, not an actual node execution receipt. */
import {FAILURE_SCHEMA,MODES,FAILURE_CHECKS,FALSE_FLAGS} from '../failure-protocol.mjs';
export const pins={expectedCommit:'a'.repeat(40),expectedTree:'b'.repeat(40)};
export function evidenceFixture(){
 const cases=MODES.map((mode,i)=>{
  const [orderHash,failureHash,counterpartyHash,successorHash]=[1,2,3,4].map(n=>(n+i*4).toString(16).toUpperCase().repeat(64));
  const signed='c'.repeat(64),cipher='d'.repeat(64),receipt={hash:failureHash,code:19,codespace:'exchange',height:String(10+i*10),gasWanted:'1000000',gasUsed:'90753'};
  const beforeFailure={base:'2000000000000000000',quote:'42',gas:'1000000000000000000000',sequence:'1',exchangeBase:'0',openOrders:0};
  const afterFailure={...beforeFailure,gas:'999999500000000000000',sequence:'2'};
  const afterSuccessor={...afterFailure,gas:'999999000000000000000',sequence:'3',base:'1750000000000000000',exchangeBase:'250000000000000000'};
  const barrier={schema:'realdex.failure-barrier.v1',mode,requestHash:failureHash,state:'broadcast-unknown',reason:'SUBMISSION_STARTING',ownerSends:1,signedSha256:signed};
  const marker={schema:'realdex.failure-crash-marker.v1',requestHash:failureHash,state:'broadcast-unknown',reason:'SUBMISSION_STARTING',receipt,ownerSends:2,signedSha256:signed,ciphertextSha256:cipher};
  return {mode,checks:[...FAILURE_CHECKS],orderHash,failureHash,counterpartyHash,successorHash,receipt,checkTxCode:0,lookupStatus:200,
   preRaceSequence:'1',beforeFailure,afterFailure,afterSuccessor,feeAtomic:'500000000000000',successorAmountAtomic:'250000000000000000',
   failedState:'reported-reverted',failedReason:'INCLUDED_FAILURE',failureReceived:true,savedFailureCode:19,savedFailureHeight:receipt.height,actionEffectPresent:false,automaticRetry:false,finalityProven:false,retirementPresent:false,
   oldTokenStatus:401,newTokenDistinct:true,oldPid:100+i,restartedPid:200+i,restoredState:i?'broadcast-unknown':'broadcast',restoredReason:i?'SUBMISSION_STARTING':'RPC_ACCEPTED_NOT_CONFIRMED',
   signedSha256:signed,restoredSignedSha256:signed,finalSignedSha256:signed,unresolvedError:'INJECTIVE_UNRESOLVED_TRANSACTION',resubmitError:'INJECTIVE_RESUBMISSION_FORBIDDEN',
   firstProcessSends:2,beforeReconcileSends:0,afterReconcileSends:0,successorProcessSends:1,finalRecordCount:3,reconcileWriteDelta:0,reconcileQueryDelta:0,failurePersistsAfterSecondRestart:true,successorState:'reported-confirmed',
   barrier,exit:{code:i?null:0,signal:i?'SIGKILL':null},httpResult:i?'connection-lost':'response-returned',crashMarker:i?marker:null,staleLockPreserved:i?true:null,sameHomeAutoRecovered:false,fixtureCopyOnly:!!i,ciphertextSha256:i?cipher:null,copiedCiphertextSha256:i?cipher:null};
 });
 return {schema:FAILURE_SCHEMA,mode:'api-included-failure',commit:pins.expectedCommit,tree:pins.expectedTree,status:'passed',sourceStable:true,referenceProduct:'INJ12',cases,ownerSubmissions:6,counterpartySubmissions:2,failedIncludedTransactions:2,forcedCrashes:1,checkCount:44,...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false]))};
}
