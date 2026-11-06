import type {IbcPrepare,IbcApprove,IbcReconcile,IbcObservation} from '../../bridge/api';
const prepare:IbcPrepare={accountId:'owner',routeId:'ibc-local-a-b',payment:{requestKey:'invoice-1',receiver:'cosmos1...',amount:'1.25',feeAtomic:'50000',gasLimit:'2000000',timeoutSeconds:300}};
const approve:IbcApprove={id:'id',intentId:'hash',confirmation:'BRIDGE cosmos1... TO realdex-local-b-1',broadcast:false};
const reconcile:IbcReconcile={id:'id'};
const report:IbcObservation={observedAt:0,stage:'awaiting-receive',received:false,refunded:false,completed:false,reason:'pending',assurance:'RPC observation',finalityProven:false,stateProofVerified:false,timeoutElapsed:false,evidenceRefs:{}};
// @ts-expect-error Display amount and atomic amount cannot both be specified.
const conflicting:IbcPrepare['payment']={requestKey:'id',receiver:'x',amount:'1',amountAtomic:'1000000',feeAtomic:'1',gasLimit:'1',timeoutSeconds:300};
// @ts-expect-error This API does not offer an independently proven finality flag.
const claimedProof:IbcObservation['finalityProven']=true;
void [prepare,approve,reconcile,report,conflicting,claimedProof];
