#!/usr/bin/env node
/** Real local VM demo. Uses only newly created disposable keys and faucet coins. */
import {startAptos} from './fixture.mjs';
import {APTOS_PIN} from './toolchain.mjs';
const chain=await startAptos(); let f;
try {
 f=await chain.fixture();
 const before={from:String(await f.balance(f.account.address)),to:String(await f.balance())};
 const p=await f.prepare(),{record}=await f.approve(p,true),observed=await f.settle(record);
 const replay=await f.prepare();
 if(!replay.alreadyRecorded) throw Error('DEMO_IDEMPOTENCY_FAILED');
 const after={from:String(await f.balance(f.account.address)),to:String(await f.balance())};
 const amount=BigInt(record.summary.amountAtomic),fee=BigInt(observed.report.feeAtomic);
 if(BigInt(before.from)-BigInt(after.from)!==amount+fee || BigInt(after.to)-BigInt(before.to)!==amount) throw Error('DEMO_BALANCE_MISMATCH');
 console.log(JSON.stringify({schema:'realdex.aptos-runtime-demo.v1',runtime:APTOS_PIN.version,
  realMoveExecution:true,singleLocalValidator:true,independentConsensusProof:false,
  forwarders:2,amountAtomic:String(amount),feeAtomic:String(fee),before,after,
  submissionCount:chain.state.sent-f.startSent,storedState:observed.state,
  receivedObservation:observed.report.received,finalityProven:false,
  simulationsOnlyZeroSignatures:chain.state.simulationSignatures.every(s=>s==='00'.repeat(64)),
  publicNetworkUsed:false,productionReady:false},null,2));
} finally {if(f)await f.close();await chain.close();}
