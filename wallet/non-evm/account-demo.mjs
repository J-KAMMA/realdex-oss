#!/usr/bin/env node
/** Synthetic HTTP demo only. Never connects to an external chain or loads real user keys. */
import {accountOnlineFixture} from '../test/account-online-fixtures.mjs';
for(const family of ['stellar','aptos']){
  const f=await accountOnlineFixture(family);
  try{
    const first=await f.approve(await f.prepare(),true),result=await f.reconcile(first.record);
    const duplicate=await f.prepare();
    console.log(JSON.stringify({family,environment:'SYNTHETIC ledger API; real Ed25519 signatures; NOT real chain execution',amountAtomic:result.summary.amountAtomic,feeAtomic:result.report.feeAtomic,state:result.state,receivedObservation:result.report.received,finalityProven:false,submissions:f.state.sent,duplicateReturnedSameRecord:duplicate.record.id===first.record.id}));
  }finally{await f.close();}
}
