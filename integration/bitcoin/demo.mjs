#!/usr/bin/env node
/** Disposable, no-P2P Bitcoin Core regtest demo. Never accesses an existing wallet. */
import {startCore,fixture} from './fixture.mjs';
const cleanup=[];let chain;
try{
 chain=await startCore();const f=await fixture({after(fn){cleanup.push(fn);}},chain);
 const p=await f.prepare(),{record}=await f.approve(p);await f.mine();const final=await f.reconcile(record);const duplicate=await f.prepare();
 console.log(JSON.stringify({scope:'real Bitcoin Core regtest, two forwarding endpoints, no P2P/public network',amountSats:final.summary.amountAtomic,feeSats:final.summary.feeAtomic,txid:final.signed.requestId,state:final.state,confirmations:final.report.confirmations,inclusion:final.report.inclusion,finalityProven:final.report.finalityProven,actualSubmissions:f.sent.length,sameRequestReused:duplicate.record.id===record.id,temporaryWallet:true},null,2));
}catch(e){console.error('Bitcoin demo failed:',/^[A-Z0-9_]+$/.test(e.message)?e.message:'TEST_FAILURE');process.exitCode=1;}
finally{for(const fn of cleanup.reverse())await fn();await chain?.close();}
