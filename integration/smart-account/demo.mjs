#!/usr/bin/env node
/** Disposable test only: throws away every generated key and chain on completion. */
import assert from 'node:assert/strict';
import {setup,until,eth} from './fixture.mjs';
import {RECIPIENT} from '../anvil/fixture.mjs';
const f=await setup();
try{
  const batch=await f.perform({type:'payments',transfers:[{asset:'native',recipient:RECIPIENT,amount:'0.01'},{asset:'native',recipient:'0x4545454545454545454545454545454545454545',amount:'0.02'}]});
  const key=await f.sessionKey();await f.grant(key,{per:10,daily:15,total:20});await f.perform({type:'session-transfer',sessionAccountId:key.id,amount:eth(10)});
  const policy=(await f.sessionState(key)).session;assert.equal(policy.spent,'10');
  let denied=false;try{await f.prepare({type:'session-transfer',sessionAccountId:key.id,amount:eth(6)});}catch{denied=true;}assert.equal(denied,true);
  const p=await f.owner('smart/message/prepare',{id:f.smart.id,message:'RealDEX smart-account demonstration\nOnly this disposable local chain.',validUntil:until()});
  const approved=await f.owner('approve',{id:p.id,intentId:p.intentId,confirm:p.summary.recipient});
  const signature=await f.owner('smart/message/verify',{messageId:approved.message.id});assert.equal(signature.valid,true);
  await f.perform({type:'revoke-all'});let revoked=false;try{await f.prepare({type:'session-transfer',sessionAccountId:key.id,amount:eth(1)});}catch{revoked=true;}assert.equal(revoked,true);
  console.log(JSON.stringify({schema:'realdex.smart-account-demo.v1',success:true,smartAccount:f.smart.address,owner:f.account.address,factory:f.market.smartFactory,chainId:'31337',atomicBatchTransaction:batch.signed.transactionHash,recipientBalanceWei:String(await f.balance(RECIPIENT)),sessionSpentWei:policy.spent,dailyLimitEnforced:denied,signatureValidBeforeRevocation:signature.valid,allSessionsRevoked:revoked,experimentalCompiler:true,erc4337:false,publicNetworkContacted:false,realAssetsUsed:false},null,2));
}finally{await f.close();}
