/** Multiple real HTTP clients, one unmodified owner server, one real local exchange node. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomBytes} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {startInjective} from '../injective/fixture.mjs';import {ApiDriver,PipeDriver} from './drivers.mjs';
import {need,cleanupAll} from './protocol.mjs';import {signedDigest} from './crash-protocol.mjs';
import {SCHEMA,MODES,CHECKS,TOTAL_CHECKS,FALSE_FLAGS,FEE,AMOUNT,verifyConcurrencyEvidence} from './concurrency-protocol.mjs';
const POLICY={gasLimit:'1000000',gasPriceAtomic:'500000000',maxGasFeeAtomic:FEE,gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000};
const host=()=>new PipeDriver({command:process.execPath,args:[fileURLToPath(new URL('./concurrency-host.mjs',import.meta.url))],timeoutMs:30000,env:{REALDEX_E2E04_CHILD:'disposable-only'}});
const ok=r=>{need(r?.status===200&&r.data&&!r.data.error,'E2E_CONCURRENCY_HTTP_SUCCESS');return r.data;};
const bad=(r,code)=>{need(r?.status===400&&r.data?.error===code,'E2E_CONCURRENCY_HTTP_REJECTION');return {status:r.status,error:r.data.error};};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+6000;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(20);}throw Error('E2E_CONCURRENCY_WAIT_TIMEOUT');}
async function stop(h){if(!h)return;if(h.exit||h.failure){await h.close();return;}try{await h.send('stop',{});}finally{await h.close();}}
async function one({chain,index,secret,mode,onStep}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-e2e04-')),password='E2E04 disposable '+randomBytes(20).toString('hex'),actor=chain.actors[index],sub=actor.subaccountId.slice(0,-1)+'1';
 let h=host(),restarted,primary;const driver=new ApiDriver(),checks=[];const pending=new Set();let gateId=0;
 const mark=id=>{need(CHECKS[mode][checks.length]===id,'E2E_CONCURRENCY_CHECK_ORDER');checks.push(id);onStep({mode,id,index:checks.length});};
 const track=p=>{pending.add(p);p.then(()=>pending.delete(p),()=>pending.delete(p));return p;};
 const arm=async point=>{const id=++gateId;await h.send('arm',{id,point});return id;};
 const reached=()=>until(async()=>{const s=await h.send('snapshot',{});return s.barrier?.reached?s:null;});
 const release=id=>h.send('release',{id});
 const state=async()=>{const bank=async denom=>(await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+actor.address+'/by_denom?denom='+denom)).balance.amount;
  const dep=(await chain.get('/injective/exchange/v1beta1/exchange/subaccountDeposit?subaccount_id='+sub+'&denom=ubase')).deposits;
  const v=dep?.available_balance??'0';need(/^(0|[1-9][0-9]*)(?:\.0+)?$/.test(v),'E2E_CONCURRENCY_EXCHANGE_UNIT');
  return {base:await bank('ubase'),gas:await bank('inj'),sequence:(await chain.get('/cosmos/auth/v1beta1/accounts/'+actor.address)).account.base_account.sequence,exchangeBase:v.split('.')[0]};
 };
 try{
  const first=await h.send('start',{home,password,create:true,secretHex:secret,chainOrigin:chain.rest});await driver.open(first);const before=await state();mark('owner-ready');
  const payment={requestKey:'e2e04-'+mode,endpoint:chain.rest,subaccountId:sub,denom:'ubase',amountAtomic:AMOUNT,policy:POLICY};
  const p=ok(await driver.request('prepare',{kind:'deposit',body:{accountId:first.accountId,payment}}));
  const approval={id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256};
  const approve=()=>driver.request('approve',approval);
  let record,details={},totalSends=0,finalState=null,hash=null,signature=null,restored=null,reconcileWriteDelta=null,reconcileQueryDelta=null;
  const initial=await h.send('snapshot',{});
  if(mode==='double-click'){
   let id=await arm('simulate');const firstApproval=track(approve());await reached();mark('approval-held');
   const approvalBusy=(await Promise.all(Array.from({length:8},()=>approve()))).map(r=>bad(r,'NON_EVM_OPERATION_BUSY'));
   const rejectedSnap=await h.send('snapshot',{});need(rejectedSnap.records.length===0&&rejectedSnap.writes===initial.writes&&rejectedSnap.ownerSends===0,'E2E_CONCURRENCY_PREMATURE_SIGNATURE');mark('eight-approvals-busy');
   await release(id);record=ok(await firstApproval).record;const signed=await h.send('snapshot',{});need(record.state==='signed'&&signed.records.length===1&&signed.writes-initial.writes===1&&signed.ownerSends===0,'E2E_CONCURRENCY_SINGLE_SIGNATURE');mark('one-signature-saved');
   const late=bad(await approve(),'NON_EVM_REQUEST_NOT_PENDING');mark('old-approval-rejected');
   id=await arm('submit');const send=track(driver.request('submit',{id:record.id,confirmation:record.signed.requestId}));const held=await reached();
   need(held.records[0].state==='broadcast-unknown'&&held.records[0].reason==='SUBMISSION_STARTING'&&held.ownerSends===0&&held.writes-signed.writes===1,'E2E_CONCURRENCY_START_NOT_SAVED');mark('submission-start-persisted');
   const submitBusy=(await Promise.all(Array.from({length:8},()=>driver.request('submit',{id:record.id,confirmation:record.signed.requestId})))).map(r=>bad(r,'NON_EVM_OPERATION_BUSY'));mark('eight-submits-busy');
   const reconcileBusy=[bad(await driver.request('reconcile',{id:record.id}),'NON_EVM_OPERATION_BUSY')];mark('concurrent-reconcile-busy');
   const last=await h.send('snapshot',{});need(last.writes===held.writes&&last.queries===held.queries,'E2E_CONCURRENCY_DUPLICATE_SIDE_EFFECT');
   details={approvalBusy,submitBusy,reconcileBusy,approvalWrites:signed.writes-initial.writes,approvalSends:signed.ownerSends,startingWrites:held.writes-signed.writes,startingState:held.records[0].state,startingReason:held.records[0].reason,startingSends:held.ownerSends,duplicateWriteDelta:last.writes-held.writes,duplicateQueryDelta:last.queries-held.queries,lateApprovalError:late.error};
   await release(id);need(ok(await send).state==='broadcast','E2E_CONCURRENCY_BROADCAST');
  }else if(mode==='lock-approval'){
   const id=await arm('simulate'),firstApproval=track(approve());await reached();mark('approval-held');
   const locked=await driver.call('lock',{});need(ok(locked).locked===true,'E2E_CONCURRENCY_LOCK_FAILED');mark('emergency-lock-returned');
   await release(id);const stopped=bad(await firstApproval,'VAULT_LOCKED');mark('approval-stopped');
   const afterLock=await h.send('snapshot',{});need(afterLock.locked&&afterLock.writes===initial.writes&&afterLock.ciphertextSha256===initial.ciphertextSha256&&afterLock.ownerSends===0,'E2E_CONCURRENCY_LOCK_SIDE_EFFECT');mark('no-signature-or-send');
   ok(await driver.call('unlock',{password}));const s=await h.send('snapshot',{});need(s.records.length===0,'E2E_CONCURRENCY_UNEXPECTED_RECORD');mark('unlock-restores-no-record');const old=bad(await approve(),'NON_EVM_REQUEST_NOT_PENDING');mark('old-approval-rejected');
   details={lockStatus:locked.status,locked:afterLock.locked,operationError:stopped.error,interruptedWriteDelta:afterLock.writes-initial.writes,interruptedSends:afterLock.ownerSends,ciphertextPreserved:afterLock.ciphertextSha256===initial.ciphertextSha256,stateAfterUnlock:null,oldApprovalError:old.error,explicitSendAfterUnlock:false};
  }else if(mode==='lock-submit'){
   record=ok(await approve()).record;mark('one-signature-saved');const signed=await h.send('snapshot',{});
   const id=await arm('simulate'),send=track(driver.request('submit',{id:record.id,confirmation:record.signed.requestId}));await reached();mark('submission-recheck-held');
   const lock=await driver.call('lock',{});need(ok(lock).locked===true,'E2E_CONCURRENCY_LOCK_FAILED');mark('emergency-lock-returned');
   await release(id);const stopped=bad(await send,'VAULT_LOCKED');mark('submission-stopped');const afterLock=await h.send('snapshot',{});
   need(afterLock.locked&&afterLock.ownerSends===0&&afterLock.writes===signed.writes&&afterLock.ciphertextSha256===signed.ciphertextSha256,'E2E_CONCURRENCY_LOCK_SIDE_EFFECT');
   ok(await driver.call('unlock',{password}));const reloaded=await h.send('snapshot',{});need(reloaded.records.length===1&&reloaded.records[0].state==='signed'&&reloaded.records[0].signedSha256===signedDigest(record.signed),'E2E_CONCURRENCY_SIGNED_CHANGED');mark('signed-record-preserved');
   details={lockStatus:lock.status,locked:afterLock.locked,operationError:stopped.error,interruptedWriteDelta:afterLock.writes-signed.writes,interruptedSends:afterLock.ownerSends,ciphertextPreserved:afterLock.ciphertextSha256===signed.ciphertextSha256,stateAfterUnlock:reloaded.records[0].state,oldApprovalError:null,explicitSendAfterUnlock:true};
   need(ok(await driver.request('submit',{id:record.id,confirmation:record.signed.requestId})).state==='broadcast','E2E_CONCURRENCY_EXPLICIT_SEND');mark('fresh-explicit-submit');
  }else if(mode==='lock-response'){
   record=ok(await approve()).record;mark('one-signature-saved');
   const id=await arm('response'),send=track(driver.request('submit',{id:record.id,confirmation:record.signed.requestId}));const held=await reached();mark('accepted-response-held');
   need((await chain.included(record.signed.requestId)).code===0,'E2E_CONCURRENCY_INCLUDED');mark('one-transaction-included');
   const lock=await driver.call('lock',{});need(ok(lock).locked===true,'E2E_CONCURRENCY_LOCK_FAILED');mark('emergency-lock-returned');await release(id);const stopped=bad(await send,'VAULT_LOCKED');
   const afterLock=await h.send('snapshot',{});need(afterLock.locked&&afterLock.writes===held.writes&&afterLock.ciphertextSha256===held.ciphertextSha256&&afterLock.ownerSends===1,'E2E_CONCURRENCY_LATE_LOCK_WRITE');mark('response-not-saved');
   totalSends=afterLock.ownerSends;const original=h;await stop(h);restarted=host();h=restarted;const next=await h.send('start',{home,password,create:false,chainOrigin:chain.rest});await driver.open(next);mark('same-home-graceful-restart');
   const old=await fetch(next.origin+'/api/status',{method:'POST',headers:{origin:next.origin,authorization:'Bearer '+first.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000),redirect:'error'});await old.body?.cancel();need(old.status===401,'E2E_CONCURRENCY_OLD_TOKEN');mark('old-token-rejected');
   const saved=await h.send('snapshot',{});need(saved.ownerSends===0&&saved.records.length===1&&saved.records[0].state==='broadcast-unknown'&&saved.records[0].reason==='SUBMISSION_STARTING'&&saved.records[0].signedSha256===signedDigest(record.signed),'E2E_CONCURRENCY_UNKNOWN_CHANGED');mark('unknown-record-preserved');
   const resend=bad(await driver.request('submit',{id:record.id,confirmation:record.signed.requestId}),'INJECTIVE_RESUBMISSION_FORBIDDEN');mark('resubmit-rejected');
   details={lockStatus:lock.status,operationError:stopped.error,acceptedCode:held.barrier.detail.acceptedCode,unknownState:saved.records[0].state,unknownReason:saved.records[0].reason,originalSends:afterLock.ownerSends,restartedSends:saved.ownerSends,oldTokenStatus:old.status,tokenChanged:next.token!==first.token,pidChanged:next.pid!==first.pid,exit:original.exit,sameHome:true,copiedVault:false,resubmitError:resend.error,ciphertextPreserved:afterLock.ciphertextSha256===held.ciphertextSha256};
  }else{
   const id=await arm('simulate'),ac=new AbortController();
   const response=track(fetch(first.origin+'/api/non-evm/approve',{method:'POST',headers:{origin:first.origin,authorization:'Bearer '+first.token,'content-type':'application/json'},body:JSON.stringify({...approval,broadcast:false}),signal:ac.signal,redirect:'error'}).then(async r=>({returned:true,status:r.status,body:await r.text()}),e=>({clientAborted:ac.signal.aborted&&e.name==='AbortError'})));
   await reached();mark('approval-held');ac.abort();const aborted=await response;need(aborted.clientAborted===true,'E2E_CONCURRENCY_CLIENT_ABORT');mark('client-disconnected');await release(id);
   const saved=await until(async()=>{const s=await h.send('snapshot',{});return !s.busy&&!s.activeApproval?s:null;});mark('approval-completed-on-server');
   const history=ok(await driver.call('non-evm/history',{}));record=history.records[0];need(history.records.length===1&&record?.state==='signed'&&saved.writes-initial.writes===1&&saved.ownerSends===0,'E2E_CONCURRENCY_DISCONNECTED_SIGNATURE');mark('one-signature-saved');
   const old=bad(await approve(),'NON_EVM_REQUEST_NOT_PENDING');mark('old-approval-rejected');details={clientAborted:aborted.clientAborted,serverFinished:!saved.busy&&!saved.activeApproval,approvalWrites:saved.writes-initial.writes,approvalSends:saved.ownerSends,oldApprovalError:old.error,explicitSubmit:true};
   need(ok(await driver.request('submit',{id:record.id,confirmation:record.signed.requestId})).state==='broadcast','E2E_CONCURRENCY_EXPLICIT_SEND');mark('fresh-explicit-submit');
  }
  if(record){
   hash=record.signed.requestId;signature=signedDigest(record.signed);
   if(mode!=='lock-response'){const tx=await chain.included(hash);need(tx.code===0&&tx.gas_wanted===POLICY.gasLimit,'E2E_CONCURRENCY_INCLUDED');mark('one-transaction-included');}
   const reconciled=ok(await driver.request('reconcile',{id:record.id}));need(reconciled.state==='reported-confirmed'&&reconciled.report?.reason==='INCLUDED_SUCCESS','E2E_CONCURRENCY_RECEIPT');finalState=reconciled.state;restored=signedDigest(reconciled.signed);mark('receipt-saved');
   const b=await h.send('snapshot',{}),r=ok(await driver.request('reconcile',{id:record.id})),a=await h.send('snapshot',{});reconcileWriteDelta=a.writes-b.writes;reconcileQueryDelta=a.queries-b.queries;
   need(reconcileWriteDelta===0&&reconcileQueryDelta===0&&signedDigest(r.signed)===signature,'E2E_CONCURRENCY_IDEMPOTENCY');mark('terminal-idempotent');
  }
  const after=await state(),n=record?1n:0n;need(BigInt(after.sequence)-BigInt(before.sequence)===n&&BigInt(before.gas)-BigInt(after.gas)===n*BigInt(FEE)&&BigInt(before.base)-BigInt(after.base)===n*BigInt(AMOUNT)&&BigInt(after.exchangeBase)-BigInt(before.exchangeBase)===n*BigInt(AMOUNT),'E2E_CONCURRENCY_ACCOUNTING');mark('final-accounting');
  const end=await h.send('snapshot',{});totalSends+=end.ownerSends;need(totalSends===Number(n)&&end.records.length===Number(n)&&end.perHash.every(p=>p.hash===hash&&p.count===1),'E2E_CONCURRENCY_SENDS');
  return {mode,checks,before,after,feeAtomic:FEE,amountAtomic:AMOUNT,ownerSends:totalSends,records:end.records.length,hash,signedSha256:signature,restoredSignedSha256:restored,finalState,reconcileWriteDelta,reconcileQueryDelta,details};
 }catch(e){primary=e;throw e;}
 finally{await cleanupAll(primary,[()=>driver.close(),()=>stop(h),async()=>{await Promise.allSettled([...pending]);},()=>fs.rmSync(home,{recursive:true,force:true})]);}
}
export async function runConcurrencyScenario({commit,tree,onStep=()=>{}}){
 need(process.platform==='linux','E2E_CONCURRENCY_LINUX_ONLY');const secrets=Array.from({length:3},()=>randomBytes(32).toString('hex'));let chain,primary;
 try{chain=await startInjective({actorSecretHexes:secrets});const cases=[];
  for(let i=0;i<MODES.length;i++)cases.push(await one({chain,index:i%3,secret:secrets[i%3],mode:MODES[i],onStep}));
  const r={schema:SCHEMA,mode:'api-concurrency',commit,tree,status:'passed',sourceStable:true,referenceProduct:'INJ12',cases,ownerSubmissions:4,forcedCrashes:0,checkCount:TOTAL_CHECKS,syntheticResponses:0,externalRequests:0,...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false])),chainVersion:chain.version,genesisSha256:chain.genesisSha256};verifyConcurrencyEvidence(r,{expectedCommit:commit,expectedTree:tree});return r;
 }catch(e){primary=e;throw e;}finally{await cleanupAll(primary,[()=>chain?.close()]);}
}
