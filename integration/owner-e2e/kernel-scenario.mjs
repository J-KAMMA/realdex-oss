/** Force-kill a disposable owner process at two known transaction boundaries. Never touch user state. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomBytes} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {startInjective} from '../injective/fixture.mjs';import {ApiDriver,PipeDriver} from './drivers.mjs';
import {need,sha,cleanupAll} from './protocol.mjs';
import {BOUNDARIES,readPrivateFile,signedDigest} from './crash-protocol.mjs';
import {KERNEL_SCHEMA,verifyKernelMarker,verifyKernelEvidence} from './kernel-protocol.mjs';
const AMOUNT='1000000000000000000',FEE='500000000000000';
const POLICY=Object.freeze({gasLimit:'1000000',gasPriceAtomic:'500000000',maxGasFeeAtomic:FEE,gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000});
const child=home=>new PipeDriver({command:'python3',args:['-I',fileURLToPath(new URL('./kernel-lease.py',import.meta.url)),'--directory',home],timeoutMs:60000,env:{REALDEX_E2E08_CHILD:'disposable-only'}});
function legacyRejected(home){
 const r=spawnSync(process.execPath,['--input-type=module','-e',`import{PrivateStore}from'./wallet/lib/storage.mjs';try{const s=new PrivateStore(process.argv[1]);s.close();process.exit(2);}catch(e){if(e.message!=='VAULT_IN_USE_OR_STALE_LOCK')process.exit(3);}`,home],{cwd:path.resolve(import.meta.dirname,'../..'),timeout:5000,encoding:'utf8'});
 need(!r.error&&r.signal===null&&r.status===0,'E2E_KERNEL_LEGACY_BARRIER');
}

const ok=x=>{need(x?.status===200&&x.data&&!x.data.error,'E2E_CRASH_OWNER_API');return x.data;};
const deadline=async(p,ms)=>{let id;try{return await Promise.race([p,new Promise((_,reject)=>{id=setTimeout(()=>reject(Error('E2E_CRASH_EXIT_TIMEOUT')),ms);})]);}finally{clearTimeout(id);}};
async function stopHost(h){if(!h)return;if(!h.exit&&!h.failure){try{await h.send('stop',{});}finally{await h.close();}}else await h.close();}
async function oneCase({chain,actorIndex,secret,boundary,onStep}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-e2e08-vault-'));const originalHomeStat=fs.statSync(home);
 const password='Disposable crash '+randomBytes(20).toString('hex'),driver=new ApiDriver(),checks=[];
 let h=child(home),recovered,probe,primary,expectedDeath=false;
 const mark=id=>{checks.push(id);onStep({boundary,id,index:checks.length});};
 const actor=chain.actors[actorIndex],sub=actor.subaccountId.slice(0,-1)+'1';
 const state=async()=>{
  const bank=async denom=>(await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+actor.address+'/by_denom?denom='+denom)).balance.amount;
  const dep=(await chain.get('/injective/exchange/v1beta1/exchange/subaccountDeposit?subaccount_id='+sub+'&denom=ubase')).deposits;
  const amount=dep?.available_balance??'0';need(/^(0|[1-9][0-9]*)(?:\.0+)?$/.test(amount),'E2E_CRASH_DEPOSIT_UNITS');
  return {base:await bank('ubase'),gas:await bank('inj'),sequence:(await chain.get('/cosmos/auth/v1beta1/accounts/'+actor.address)).account.base_account.sequence,exchangeBase:amount.split('.')[0]};
 };
 try{
  const config=await h.send('start',{home,password,create:true,secretHex:secret,chainOrigin:chain.rest});await driver.open(config);
  const before=await state();need(before.sequence==='0'&&before.exchangeBase==='0','E2E_CRASH_FRESH_OWNER');mark('fresh-owner');
  const busy=child(home);try{let code;try{await busy.send('probe',{});}catch(e){code=e.message;}need(code==='E2E_KERNEL_BUSY','E2E_KERNEL_SECOND_WRITER');}finally{await busy.close();}
  mark('live-kernel-writer-rejected');legacyRejected(home);mark('legacy-writer-rejected');
  const requestKey='e2e08-'+boundary;
  const payment={requestKey,endpoint:chain.rest,subaccountId:sub,denom:'ubase',amountAtomic:AMOUNT,policy:POLICY};
  const p=ok(await driver.request('prepare',{kind:'deposit',body:{accountId:config.accountId,payment}}));
  need(p.summary.amountAtomic===AMOUNT&&p.summary.feeAtomic===FEE&&p.summary.destination===sub,'E2E_CRASH_REVIEW_BINDING');mark('review-bound');
  const signed=ok(await driver.request('approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256})).record;
  need(signed.state==='signed'&&(await h.send('snapshot',{})).transportCalls===0,'E2E_CRASH_PREMATURE_SEND');
  const requestHash=signed.signed.requestId,originalDigest=signedDigest(signed.signed);mark('signed-no-send');
  await h.send('arm',{boundary,requestHash});
  let httpResult;
  try{await driver.request('submit',{id:signed.id,confirmation:requestHash});httpResult='response-returned';}
  catch{httpResult='connection-lost';}
  const exit=await deadline(h.closed,5000);
  const marker=JSON.parse(readPrivateFile(path.join(home,'kernel-crash-marker.json'),16384).toString('utf8'));
  verifyKernelMarker(marker,boundary,requestHash);need(marker.signedSha256===originalDigest,'E2E_CRASH_MARKER_SIGNED');mark('crash-marker-bound');
  need(exit.code===null&&exit.signal==='SIGKILL'&&httpResult==='connection-lost','E2E_CRASH_UNEXPECTED_EXIT');expectedDeath=true;mark('sigkill-confirmed');
  // No PID inference, lock unlink or copied Vault: reacquire the kernel lease on the SAME inode.
  const lockBefore=readPrivateFile(path.join(home,'writer.lock'),128),lockStat=fs.lstatSync(path.join(home,'writer.lock'));
  legacyRejected(home);mark('legacy-still-rejected');
  const cipher=readPrivateFile(path.join(home,'vault.json')),ciphertextSha256=sha(cipher);
  need(ciphertextSha256===marker.ciphertextSha256,'E2E_KERNEL_CIPHER_CHANGED');
  recovered=child(home);const next=await recovered.send('start',{home,password,create:false,chainOrigin:chain.rest});
  const reopenedCipherSha256=sha(readPrivateFile(path.join(home,'vault.json'))),lockAfter=fs.lstatSync(path.join(home,'writer.lock')),dirAfter=fs.statSync(home);
  need(lockBefore.equals(readPrivateFile(path.join(home,'writer.lock'),128))&&lockAfter.ino===lockStat.ino&&lockAfter.ino===marker.lockInode&&lockAfter.dev===lockStat.dev&&dirAfter.ino===originalHomeStat.ino&&dirAfter.ino===marker.directoryInode&&dirAfter.dev===originalHomeStat.dev,'E2E_KERNEL_INODE_CHANGED');mark('persistent-inodes-retained');
  need(reopenedCipherSha256===ciphertextSha256,'E2E_KERNEL_REOPEN_CHANGED_CIPHER');mark('same-directory-reopened');
  need(next.pid!==config.pid&&next.token!==config.token&&next.accountId===config.accountId,'E2E_CRASH_RESTART_CHANGED');await driver.open(next);mark('new-process-new-token');
  const denied=await fetch(next.origin+'/api/status',{method:'POST',headers:{origin:next.origin,authorization:'Bearer '+config.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000),redirect:'error'});await denied.body?.cancel();need(denied.status===401,'E2E_CRASH_OLD_TOKEN');mark('old-token-rejected');
  const restored=await recovered.send('snapshot',{}),r=restored.records[0];
  need(restored.transportCalls===0&&restored.records.length===1&&r.id===signed.id&&r.hash===requestHash&&r.signedSha256===originalDigest&&r.state==='broadcast-unknown'&&r.reason==='SUBMISSION_STARTING','E2E_CRASH_RESTORE_CHANGED');mark('exact-record-restored');
  const no=await driver.request('submit',{id:signed.id,confirmation:requestHash});need(no.status===400&&no.data?.error==='INJECTIVE_RESUBMISSION_FORBIDDEN','E2E_CRASH_RESUBMISSION_ALLOWED');mark('resubmit-rejected');
  const replacement=await driver.request('prepare',{kind:'deposit',body:{accountId:next.accountId,payment:{...payment,requestKey:requestKey+'-new'}}});
  const approval=replacement.status===200?await driver.request('approve',{id:replacement.data.id,intentId:replacement.data.intentId,confirmation:replacement.data.summary.reviewSha256}):replacement;
  need(approval.status===400&&approval.data?.error==='INJECTIVE_UNRESOLVED_TRANSACTION','E2E_CRASH_UNRESOLVED_BYPASSED');mark('unresolved-blocks-new-approval');
  const lookup=await fetch(chain.rest+'/cosmos/tx/v1beta1/txs/'+requestHash,{signal:AbortSignal.timeout(5000),redirect:'error'});let receipt=null;
  if(boundary==='after-inclusion'){
   const raw=await lookup.json(),t=raw.tx_response;need(lookup.status===200&&t?.txhash===requestHash&&t.code===0,'E2E_CRASH_CHAIN_OUTCOME');
   receipt={hash:t.txhash,height:String(t.height),code:t.code,gasWanted:String(t.gas_wanted),gasUsed:String(t.gas_used)};
  }else{await lookup.body?.cancel();need(lookup.status===404,'E2E_CRASH_BEFORE_SEND_INCLUDED');}
  mark('chain-outcome-matches-boundary');
  const result=ok(await driver.request('reconcile',{id:signed.id}));
  need(result.signed.requestId===requestHash&&result.state===(boundary==='after-inclusion'?'reported-confirmed':'broadcast-unknown'),'E2E_CRASH_RECONCILE_CHANGED');mark('stored-hash-reconciled');
  const final=await recovered.send('snapshot',{});need(final.transportCalls===0&&final.records.length===1,'E2E_CRASH_RESTART_SENT');mark('no-restart-send');
  const after=await state(),included=boundary==='after-inclusion';
  need(BigInt(after.sequence)-BigInt(before.sequence)===(included?1n:0n)&&BigInt(before.gas)-BigInt(after.gas)===(included?BigInt(FEE):0n)&&BigInt(before.base)-BigInt(after.base)===(included?BigInt(AMOUNT):0n)&&after.exchangeBase===(included?AMOUNT:'0'),'E2E_CRASH_ACCOUNTING');mark('exact-accounting');
  return {boundary,checks,requestHash,exit,httpResult,marker,legacyModeRejected:true,kernelBusyRejected:true,lockFileUnlinked:false,vaultCopied:false,sameHomeRecovered:true,lockInodeBefore:lockStat.ino,lockInodeAfter:lockAfter.ino,directoryInodeBefore:originalHomeStat.ino,directoryInodeAfter:dirAfter.ino,
   ciphertextSha256,reopenedCipherSha256,signedSha256:originalDigest,restoredSignedSha256:r.signedSha256,oldPid:config.pid,newPid:next.pid,tokenChanged:true,oldTokenStatus:denied.status,
   restoredState:r.state,restoredReason:r.reason,records:final.records.length,resubmitError:no.data.error,newApprovalError:approval.data.error,
   transportCalls:marker.transportCalls,restartedTransportCalls:final.transportCalls,lookupStatus:lookup.status,finalState:result.state,amountAtomic:AMOUNT,feeAtomic:FEE,before,after,receipt};
 }catch(e){primary=e;throw e;}
 finally{await cleanupAll(primary,[()=>driver.close(),()=>stopHost(recovered),()=>stopHost(probe),async()=>{
   if(expectedDeath){try{await h.close();}catch(e){need(e.message==='E2E_CHILD_EXIT','E2E_CRASH_CLEANUP_UNEXPECTED');}}
   else await stopHost(h);
  },()=>fs.rmSync(home,{recursive:true,force:true})]);}
}
export async function runKernelScenario({commit,tree,onStep=()=>{}}){
 need(process.platform==='linux','E2E_CRASH_LINUX_FIXTURE_REQUIRED');const secrets=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')];let chain,primary;
 try{
  chain=await startInjective({actorSecretHexes:secrets});const cases=[];
  for(let i=0;i<BOUNDARIES.length;i++)cases.push(await oneCase({chain,actorIndex:i,secret:secrets[i],boundary:BOUNDARIES[i],onStep}));
  const result={schema:KERNEL_SCHEMA,mode:'kernel-lease-candidate',commit,tree,status:'passed',sourceStable:true,referenceProduct:'INJ12',productSuccessor:false,cases,ownerSubmissions:1,forcedCrashes:2,checkCount:cases.reduce((n,c)=>n+c.checks.length,0),
   publicNetwork:false,productionReady:false,wholeProductAcceptance:false,browserEndToEndPassed:false,checkpointCompatibilityVerified:false,powerLossTested:false,stateProofVerified:false,
   chainVersion:chain.version,genesisSha256:chain.genesisSha256};
  verifyKernelEvidence(result,{expectedCommit:commit,expectedTree:tree});return result;
 }catch(e){primary=e;throw e;}finally{await cleanupAll(primary,[()=>chain?.close()]);}
}
