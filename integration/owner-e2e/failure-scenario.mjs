/** Actual local exchange failure after final review, with normal response and SIGKILL recovery. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {startInjective,orderRequest} from '../injective/fixture.mjs';
import {preflightInjectiveLimitOrder} from '../../node/external/injective-preflight.mjs';
import {ApiDriver,PipeDriver} from './drivers.mjs';import {need,sha,cleanupAll} from './protocol.mjs';
import {readPrivateFile,writeExclusive,signedDigest} from './crash-protocol.mjs';
import {FAILURE_SCHEMA,MODES,FALSE_FLAGS,failedReceipt,verifyFailureEvidence} from './failure-protocol.mjs';
const FEE='500000000000000',AMOUNT='250000000000000000';
const POLICY={gasLimit:'1000000',gasPriceAtomic:'500000000',maxGasFeeAtomic:FEE,gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000};
const child=()=>new PipeDriver({command:process.execPath,args:[fileURLToPath(new URL('./failure-host.mjs',import.meta.url))],timeoutMs:60000,env:{REALDEX_E2E03_CHILD:'disposable-only'}});
const ok=x=>{need(x?.status===200&&x.data&&!x.data.error,'E2E_FAILURE_OWNER_API');return x.data;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async fn=>{const until=Date.now()+15000;while(Date.now()<until){const r=await fn();if(r)return r;await sleep(50);}throw Error('E2E_FAILURE_WAIT_TIMEOUT');};
const deadline=async(p,ms)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('E2E_FAILURE_EXIT_TIMEOUT')),ms))]);}finally{clearTimeout(timer);}};
async function stop(h){if(!h)return;if(h.exit||h.failure){await h.close();return;}try{await h.send('stop',{});}finally{await h.close();}}
async function one({chain,index,secret,mode,onStep}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-e2e03-')),copyHome=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-e2e03-'));
 const password='E2E03 disposable '+randomBytes(20).toString('hex'),actor=chain.actors[index],sub=actor.subaccountId.slice(0,-1)+'1',driver=new ApiDriver(),checks=[];
 let h=child(),currentHost=h,probe,restarted,finalHost,primary,submission;
 const mark=id=>{checks.push(id);onStep({mode,id,index:checks.length});};
 const state=async()=>{
  const bank=async d=>(await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+actor.address+'/by_denom?denom='+d)).balance.amount;
  const d=(await chain.get('/injective/exchange/v1beta1/exchange/subaccountDeposit?subaccount_id='+sub+'&denom=ubase')).deposits;
  const amount=d?.available_balance??'0';need(/^(0|[1-9][0-9]*)(?:\.0+)?$/.test(amount),'E2E_FAILURE_EXCHANGE_UNITS');
  const orders=(await chain.get('/injective/exchange/v2/spot/orders/'+chain.market.market_id+'/'+actor.subaccountId)).orders??[];
  return {base:await bank('ubase'),quote:await bank('uquote'),gas:await bank('inj'),sequence:(await chain.get('/cosmos/auth/v1beta1/accounts/'+actor.address)).account.base_account.sequence,exchangeBase:amount.split('.')[0],openOrders:orders.length};
 };
 const sign=async(kind,body)=>{const p=ok(await driver.request('prepare',{kind,body}));return ok(await driver.request('approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256})).record;};
 const requestKey='e2e03-'+mode;
 try{
  const first=await h.send('start',{home,password,create:true,secretHex:secret,chainOrigin:chain.rest});await driver.open(first);
  const fresh=await state();need(fresh.sequence==='0'&&fresh.openOrders===0&&fresh.exchangeBase==='0','E2E_FAILURE_FRESH_OWNER');mark('fresh-owner');
  const review=await preflightInjectiveLimitOrder(await orderRequest(chain,index,{side:'sell',quantity:'1',requestKey:requestKey+'-order'}));
  const sell=await sign('order',{accountId:first.accountId,review});need(sell.summary.amountAtomic==='1000000000000000000'&&sell.summary.feeAtomic===FEE,'E2E_FAILURE_ORDER_BINDING');
  need(ok(await driver.request('submit',{id:sell.id,confirmation:sell.signed.requestId})).state==='broadcast','E2E_FAILURE_ORDER_SEND');need((await chain.included(sell.signed.requestId)).code===0,'E2E_FAILURE_ORDER_INCLUDED');
  const source=ok(await driver.request('reconcile',{id:sell.id}));need(source.state==='reported-confirmed','E2E_FAILURE_ORDER_RECORD');
  const orders=(await chain.get('/injective/exchange/v2/spot/orders/'+chain.market.market_id+'/'+actor.subaccountId)).orders??[];
  need(orders.length===1&&orders[0].fillable==='1.000000000000000000','E2E_FAILURE_ORDER_SIZE');mark('order-included');
  const cancel=await sign('cancel',{accountId:first.accountId,sourceRecordId:source.id,payment:{requestKey:requestKey+'-cancel',orderHash:orders[0].order_hash,policy:POLICY}});
  const failureHash=cancel.signed.requestId,originalDigest=signedDigest(cancel.signed);
  need(cancel.state==='signed'&&cancel.summary.amountAtomic==='1000000000000000000'&&cancel.summary.feeAtomic===FEE&&(await h.send('snapshot',{})).ownerSends===1,'E2E_FAILURE_CANCEL_BINDING');mark('cancel-reviewed-signed');
  await h.send('arm',{mode,requestHash:failureHash});
  // Start the real owner API request, pause only its test transport boundary AFTER persistence.
  submission=driver.request('submit',{id:cancel.id,confirmation:failureHash}).then(v=>({httpResult:'response-returned',response:v}),()=>({httpResult:'connection-lost'}));
  const readyPath=path.join(home,'ready.json');await wait(()=>fs.existsSync(readyPath));const barrier=JSON.parse(readPrivateFile(readyPath,4096).toString('utf8'));
  need(barrier.requestHash===failureHash&&barrier.mode===mode&&barrier.ownerSends===1&&barrier.state==='broadcast-unknown'&&barrier.signedSha256===originalDigest,'E2E_FAILURE_BARRIER');mark('before-send-barrier');
  const preRaceSequence=(await state()).sequence;
  // A DIFFERENT actor fills the order. Owner sequence and signed cancel bytes are untouched.
  const other=await preflightInjectiveLimitOrder(await orderRequest(chain,2,{side:'buy',quantity:'1',requestKey:requestKey+'-counterparty'}));
  const sent=await chain.broadcast(chain.sign(other.transaction,2));need(sent.tx_response?.code===0,'E2E_FAILURE_COUNTERPARTY_CHECKTX');const counterpartyHash=sent.tx_response.txhash;
  need((await chain.included(counterpartyHash)).code===0,'E2E_FAILURE_COUNTERPARTY_INCLUDED');await wait(async()=>{const s=await state();return s.openOrders===0;});mark('counterparty-full-fill');
  const beforeFailure=await state();need(beforeFailure.sequence===preRaceSequence&&preRaceSequence==='1','E2E_FAILURE_SEQUENCE_RACE');mark('unchanged-owner-sequence');
  writeExclusive(path.join(home,'release.json'),JSON.stringify({schema:'realdex.failure-release.v1',requestHash:failureHash})+'\n');
  const http=await submission;let exit,crashMarker=null,ciphertextSha256=null,copiedCiphertextSha256=null,staleLockPreserved=null,recoveryHome=home;
  if(mode==='kill-before-record'){
   exit=await deadline(h.closed,5000);need(exit.code===null&&exit.signal==='SIGKILL'&&http.httpResult==='connection-lost','E2E_FAILURE_EXPECTED_SIGKILL');
   crashMarker=JSON.parse(readPrivateFile(path.join(home,'failure-marker.json'),16384).toString('utf8'));need(crashMarker.ownerSends===2,'E2E_FAILURE_SEND_COUNT');
  }else{need(ok(http.response).state==='broadcast'&&(await h.send('snapshot',{})).ownerSends===2,'E2E_FAILURE_BROADCAST_STATE');}
  mark('one-failed-submission');
  const q=await fetch(chain.rest+'/cosmos/tx/v1beta1/txs/'+failureHash,{signal:AbortSignal.timeout(5000),redirect:'error'});need(q.status===200,'E2E_FAILURE_RECEIPT_HTTP');const receipt=failedReceipt((await q.json()).tx_response,failureHash);need(receipt.codespace==='exchange','E2E_FAILURE_EXCHANGE_REJECTION');mark('failure-on-real-chain');
  if(mode==='kill-before-record'){
   const lock=readPrivateFile(path.join(home,'writer.lock'),128),stat=fs.lstatSync(path.join(home,'writer.lock'));
   probe=child();let error;try{await probe.send('start',{home,password,create:false,chainOrigin:chain.rest});}catch(e){error=e.message;}
   need(error==='E2E_FAILURE_STALE_LOCK','E2E_FAILURE_STALE_LOCK_BYPASSED');await probe.close();probe=null;
   const s=fs.lstatSync(path.join(home,'writer.lock'));staleLockPreserved=lock.equals(readPrivateFile(path.join(home,'writer.lock'),128))&&s.ino===stat.ino&&s.dev===stat.dev;need(staleLockPreserved,'E2E_FAILURE_STALE_LOCK_CHANGED');
   const cipher=readPrivateFile(path.join(home,'vault.json'));ciphertextSha256=sha(cipher);need(ciphertextSha256===crashMarker.ciphertextSha256,'E2E_FAILURE_CIPHER');writeExclusive(path.join(copyHome,'vault.json'),cipher);copiedCiphertextSha256=sha(readPrivateFile(path.join(copyHome,'vault.json')));recoveryHome=copyHome;
  }else{await stop(h);exit=h.exit;}
  restarted=child();currentHost=restarted;const next=await restarted.send('start',{home:recoveryHome,password,create:false,chainOrigin:chain.rest});await driver.open(next);need(next.pid!==first.pid&&next.token!==first.token&&next.accountId===first.accountId,'E2E_FAILURE_RESTART_IDENTITY');mark('restart-boundary-verified');
  const denied=await fetch(next.origin+'/api/status',{method:'POST',headers:{origin:next.origin,authorization:'Bearer '+first.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000),redirect:'error'});await denied.body?.cancel();need(denied.status===401,'E2E_FAILURE_OLD_SESSION');mark('old-session-rejected');
  const snap=await restarted.send('snapshot',{}),restored=snap.records.find(r=>r.hash===failureHash);need(snap.records.length===2&&snap.ownerSends===0&&restored?.signedSha256===originalDigest&&restored.state===(mode==='response'?'broadcast':'broadcast-unknown'),'E2E_FAILURE_RECORD');mark('exact-unresolved-record');
  const rejected=await driver.request('submit',{id:cancel.id,confirmation:failureHash});need(rejected.status===400&&rejected.data?.error==='INJECTIVE_RESUBMISSION_FORBIDDEN','E2E_FAILURE_RESUBMIT');mark('resubmit-rejected');
  const payment={requestKey:requestKey+'-new',endpoint:chain.rest,subaccountId:sub,denom:'ubase',amountAtomic:AMOUNT,policy:POLICY};
  const p=await driver.request('prepare',{kind:'deposit',body:{accountId:next.accountId,payment}});
  const pending=p.status===200?await driver.request('approve',{id:p.data.id,intentId:p.data.intentId,confirmation:p.data.summary.reviewSha256}):p;
  need(pending.status===400&&pending.data?.error==='INJECTIVE_UNRESOLVED_TRANSACTION','E2E_FAILURE_UNRESOLVED');mark('unresolved-blocks-new-approval');
  const reverted=ok(await driver.request('reconcile',{id:cancel.id}));need(reverted.state==='reported-reverted'&&reverted.report?.reason==='INCLUDED_FAILURE'&&reverted.report.received===true&&reverted.report.code===receipt.code&&reverted.report.height===receipt.height,'E2E_FAILURE_RECONCILE');mark('failed-receipt-reconciled');
  need(!Object.hasOwn(reverted.report,'actionEffect')&&!Object.hasOwn(reverted,'retirement')&&reverted.report.automaticRetry===false&&reverted.report.finalityProven===false,'E2E_FAILURE_EFFECT');mark('failure-has-no-action-effect');
  const afterFailure=await state();need(afterFailure.base===beforeFailure.base&&afterFailure.quote===beforeFailure.quote&&afterFailure.exchangeBase===beforeFailure.exchangeBase&&BigInt(afterFailure.sequence)===BigInt(beforeFailure.sequence)+1n&&BigInt(beforeFailure.gas)-BigInt(afterFailure.gas)===BigInt(FEE),'E2E_FAILURE_COSTS');mark('failed-tx-costs-retained');
  const beforeRepeat=await restarted.send('snapshot',{}),again=ok(await driver.request('reconcile',{id:cancel.id})),afterRepeat=await restarted.send('snapshot',{});
  const reconcileWriteDelta=afterRepeat.writes-beforeRepeat.writes,reconcileQueryDelta=afterRepeat.queries-beforeRepeat.queries;
  need(signedDigest(again)===signedDigest(reverted)&&reconcileWriteDelta===0&&reconcileQueryDelta===0&&afterRepeat.ownerSends===0,'E2E_FAILURE_IDEMPOTENCY');mark('terminal-reconcile-idempotent');
  await stop(restarted);finalHost=child();currentHost=finalHost;const last=await finalHost.send('start',{home:recoveryHome,password,create:false,chainOrigin:chain.rest});await driver.open(last);
  const saved=(await finalHost.send('snapshot',{})).records.find(r=>r.hash===failureHash);need(saved?.state==='reported-reverted'&&saved.report.reason==='INCLUDED_FAILURE'&&saved.report.code===receipt.code&&saved.signedSha256===originalDigest,'E2E_FAILURE_TERMINAL_PERSISTENCE');mark('restart-after-failure-preserves-record');
  const successor=await sign('deposit',{accountId:last.accountId,payment});need(successor.state==='signed'&&successor.signed.requestId!==failureHash,'E2E_FAILURE_SUCCESSOR_APPROVAL');mark('new-owner-approval');
  need(ok(await driver.request('submit',{id:successor.id,confirmation:successor.signed.requestId})).state==='broadcast','E2E_FAILURE_SUCCESSOR_SEND');need((await chain.included(successor.signed.requestId)).code===0,'E2E_FAILURE_SUCCESSOR_INCLUDED');const confirmed=ok(await driver.request('reconcile',{id:successor.id}));need(confirmed.state==='reported-confirmed','E2E_FAILURE_SUCCESSOR_RECORD');mark('successor-included');
  const afterSuccessor=await state();need(BigInt(afterSuccessor.sequence)===BigInt(afterFailure.sequence)+1n&&BigInt(afterFailure.gas)-BigInt(afterSuccessor.gas)===BigInt(FEE)&&BigInt(afterFailure.base)-BigInt(afterSuccessor.base)===BigInt(AMOUNT)&&afterSuccessor.exchangeBase===AMOUNT&&afterSuccessor.quote===afterFailure.quote,'E2E_FAILURE_FINAL_ACCOUNTING');mark('final-accounting');
  const final=await finalHost.send('snapshot',{});need(final.ownerSends===1&&final.records.length===3&&final.perHash[0]?.hash===successor.signed.requestId&&final.perHash[0]?.count===1,'E2E_FAILURE_UNIQUE_SENDS');mark('unique-sends');
  return {mode,checks,orderHash:sell.signed.requestId,failureHash,counterpartyHash,successorHash:successor.signed.requestId,receipt,checkTxCode:0,lookupStatus:q.status,
   preRaceSequence,beforeFailure,afterFailure,afterSuccessor,feeAtomic:FEE,successorAmountAtomic:AMOUNT,
   failedState:reverted.state,failedReason:reverted.report.reason,failureReceived:reverted.report.received,savedFailureCode:reverted.report.code,savedFailureHeight:reverted.report.height,actionEffectPresent:Object.hasOwn(reverted.report,'actionEffect'),automaticRetry:reverted.report.automaticRetry,finalityProven:reverted.report.finalityProven,retirementPresent:Object.hasOwn(reverted,'retirement'),
   oldTokenStatus:denied.status,newTokenDistinct:next.token!==first.token,oldPid:first.pid,restartedPid:next.pid,restoredState:restored.state,restoredReason:restored.report.reason,
   signedSha256:originalDigest,restoredSignedSha256:restored.signedSha256,finalSignedSha256:saved.signedSha256,unresolvedError:pending.data.error,resubmitError:rejected.data.error,
   firstProcessSends:2,beforeReconcileSends:snap.ownerSends,afterReconcileSends:afterRepeat.ownerSends,successorProcessSends:final.ownerSends,finalRecordCount:final.records.length,
   reconcileWriteDelta,reconcileQueryDelta,failurePersistsAfterSecondRestart:true,successorState:confirmed.state,
   barrier,exit,httpResult:http.httpResult,crashMarker,staleLockPreserved,sameHomeAutoRecovered:false,fixtureCopyOnly:mode==='kill-before-record',ciphertextSha256,copiedCiphertextSha256};
 }catch(e){primary=e;throw e;}
 finally{await cleanupAll(primary,[()=>driver.close(),()=>stop(finalHost),()=>stop(restarted),()=>stop(probe),async()=>{if(h.exit?.signal==='SIGKILL'){try{await h.close();}catch(e){need(e.message==='E2E_CHILD_EXIT','E2E_FAILURE_EXPECTED_DEATH');}}else await stop(h);},async()=>{if(submission)await deadline(submission,25000);},()=>fs.rmSync(home,{recursive:true,force:true}),()=>fs.rmSync(copyHome,{recursive:true,force:true})]);}
}
export async function runFailureScenario({commit,tree,onStep=()=>{}}){
 need(process.platform==='linux','E2E_FAILURE_LINUX_ONLY');const secrets=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')];let chain,primary;
 try{chain=await startInjective({actorSecretHexes:secrets});const cases=[];for(let i=0;i<MODES.length;i++)cases.push(await one({chain,index:i,secret:secrets[i],mode:MODES[i],onStep}));
  const result={schema:FAILURE_SCHEMA,mode:'api-included-failure',commit,tree,status:'passed',sourceStable:true,referenceProduct:'INJ12',cases,ownerSubmissions:6,counterpartySubmissions:2,failedIncludedTransactions:2,forcedCrashes:1,checkCount:44,...Object.fromEntries(FALSE_FLAGS.map(x=>[x,false])),chainVersion:chain.version,genesisSha256:chain.genesisSha256};
  verifyFailureEvidence(result,{expectedCommit:commit,expectedTree:tree});return result;
 }catch(e){primary=e;throw e;}finally{await cleanupAll(primary,[()=>chain?.close()]);}
}
