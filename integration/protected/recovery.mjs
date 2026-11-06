import {canonical} from '../../wallet/lib/guard.mjs';
/** Integrated UP01 storage + actual owner API + pinned local chain. Disposable actors only. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
import {startInjective} from '../injective/fixture.mjs';import {ApiDriver,PipeDriver} from '../owner-e2e/drivers.mjs';
import {need,sha,cleanupAll} from '../owner-e2e/protocol.mjs';
const AMOUNT='1000000000000000000',FEE='500000000000000';
const POLICY={gasLimit:'1000000',gasPriceAtomic:'500000000',maxGasFeeAtomic:FEE,gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000};
const open=(home,cp,enroll=false)=>new PipeDriver({command:'python3',args:['-I','-S',fileURLToPath(new URL('./test-launch.py',import.meta.url)),home,cp,enroll?'yes':'no','host'],timeoutMs:60000});
async function close(h){if(!h)return;if(!h.exit&&!h.failure){try{await h.send('stop',{});}finally{await h.close();}}else await h.close();}
const ok=x=>{need(x?.status===200&&!x.data?.error,'E2E_CP_API_'+(x?.data?.error??'FAIL'));return x.data;};
async function browser(config,output){
 const args=['-I',fileURLToPath(new URL('./browser-check.py',import.meta.url)),output];
 return new Promise(resolve=>{
  const p=spawn('python3',args,{stdio:['pipe','pipe','pipe'],shell:false,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8'}});
  let stdout='',bytes=0,finished=false;
  const timer=setTimeout(()=>p.kill('SIGKILL'),45000);
  p.stdout.on('data',b=>{bytes+=b.length;if(bytes>65536)p.kill('SIGKILL');else stdout+=b;});
  p.stderr.on('data',b=>{bytes+=b.length;if(bytes>65536)p.kill('SIGKILL');});
  p.on('error',()=>{finished=true;clearTimeout(timer);resolve({passed:false,error:'BROWSER_PROCESS_ERROR',policyChanged:false,syntheticResponses:0});});
  p.on('close',(status,signal)=>{
   if(finished)return;clearTimeout(timer);
   try{const r=JSON.parse(stdout);need((status===0&&r.passed===true||status===2&&r.passed===false)&&!signal&&r.policyChanged===false&&r.syntheticResponses===0,'E2E_CP_BROWSER_RESULT');resolve(r);}
   catch{resolve({passed:false,error:'BROWSER_RUN_INCOMPLETE',status,signal,policyChanged:false,syntheticResponses:0});}
  });
  p.stdin.end(JSON.stringify(config));
 });
}
async function one({chain,actorIndex,secret,mode,onStep,output}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-vault-')),cp=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-witness-'));
 const password='UP01 ephemeral '+randomBytes(18).toString('hex');let h,next,restoreHost,primary,config;
 const api=new ApiDriver(),checks=[],mark=x=>{checks.push(x);onStep({mode,check:x});};
 const actor=chain.actors[actorIndex],sub=actor.subaccountId.slice(0,-1)+'1';
 const state=async()=>{
  const balance=async d=>(await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+actor.address+'/by_denom?denom='+d)).balance.amount;
  const dep=(await chain.get('/injective/exchange/v1beta1/exchange/subaccountDeposit?subaccount_id='+sub+'&denom=ubase')).deposits?.available_balance??'0';
  need(/^(0|[1-9][0-9]*)(?:\.0+)?$/.test(dep),'E2E_CP_DEPOSIT_UNITS');
  return {base:await balance('ubase'),gas:await balance('inj'),sequence:(await chain.get('/cosmos/auth/v1beta1/accounts/'+actor.address)).account.base_account.sequence,exchange:dep.split('.')[0]};
 };
 try{
  h=open(home,cp,true);config=await h.send('start',{home,checkpoint:cp,chainOrigin:chain.rest,password,create:true,secretHex:secret});await api.open(config);
  const initial=await h.send('snapshot',{});need(initial.protection.scheme==='realdex.vault-checkpoint-lease.v1','E2E_CP_PROTECTION');mark('encrypted-protection-enabled');
  const oldCipher=fs.readFileSync(path.join(home,'vault.json'),'utf8');
  const before=await state();need(before.sequence==='0'&&before.exchange==='0','E2E_CP_FRESH_OWNER');mark('fresh-owner');
  const locks=[home,cp].map(d=>fs.statSync(path.join(d,'writer.lock')).ino);
  const other=open(home,cp);try{await other.send('start',{home,checkpoint:cp,chainOrigin:chain.rest,password,create:false});throw Error('E2E_CP_SECOND_ALLOWED');}catch(e){need(e.message==='E2E_CP_BUSY','E2E_CP_SECOND_WRITER');}finally{await close(other);}mark('second-writer-rejected');
  const payment={requestKey:'up01-'+mode,endpoint:chain.rest,subaccountId:sub,denom:'ubase',amountAtomic:AMOUNT,policy:POLICY};
  const prep=ok(await api.request('prepare',{kind:'deposit',body:{accountId:config.accountId,payment}}));
  const signed=ok(await api.request('approve',{id:prep.id,intentId:prep.intentId,confirmation:prep.summary.reviewSha256})).record;
  const hash=signed.signed.requestId,sigHash=sha(canonical(signed.signed));
  need(signed.state==='signed'&&(await h.send('snapshot',{})).transmissions===0,'E2E_CP_PREMATURE_SEND');mark('signature-saved-with-checkpoint');
  if(mode==='save-intent'){
   await h.send('fault',{stage:'intent'});
   const failed=await api.request('submit',{id:signed.id,confirmation:hash});
   need(failed.status===400&&failed.data.error==='CP_TEST_SAVE_FAILURE','E2E_CP_SAVE_FAIL');
   const snap=await h.send('snapshot',{});need(snap.locked&&snap.transmissions===0,'E2E_CP_SAVE_SENT');
   mark('pending-checkpoint-failure-locks-no-send');await close(h);h=null;
  }else{
   await h.send('arm',{boundary:mode,hash});let lost=false;
   try{await api.request('submit',{id:signed.id,confirmation:hash});}catch{lost=true;}
   const dead=await h.closed;need(dead.signal==='SIGKILL'&&dead.code===null&&lost,'E2E_CP_CRASH');
   const m=JSON.parse(fs.readFileSync(path.join(home,'test-crash.json')));
   need(m.hash===hash&&m.transmissions===(mode==='after-inclusion'?1:0),'E2E_CP_CRASH_MARKER');mark('sigkill-at-known-boundary');
  }
  const afterCrashCipher=sha(fs.readFileSync(path.join(home,'vault.json')));
  next=open(home,cp);const restarted=await next.send('start',{home,checkpoint:cp,chainOrigin:chain.rest,password,create:false});await api.open(restarted);
  const snap=await next.send('snapshot',{});
  need(snap.transmissions===0&&snap.records.length===1&&snap.records[0].state==='broadcast-unknown'&&snap.records[0].hash===hash&&snap.records[0].signedSha256===sigHash,'E2E_CP_RECOVERY');
  need(snap.protection.pairId===initial.protection.pairId,'E2E_CP_SAME_PAIR');mark('same-directory-pair-and-signature-recovered');
  for(let i=0;i<2;i++)need(fs.statSync(path.join([home,cp][i],'writer.lock')).ino===locks[i],'E2E_CP_INODE');mark('both-permanent-lock-inodes-retained');
  if(mode==='save-intent')need(snap.protection.recoveryPerformed===true,'E2E_CP_COMMIT_NOT_RECOVERED');
  else need(sha(fs.readFileSync(path.join(home,'vault.json')))===afterCrashCipher,'E2E_CP_UNLOCK_REWROTE');mark('only-recorded-ciphertext-used');
  const oldToken=await fetch(restarted.origin+'/api/status',{method:'POST',headers:{origin:restarted.origin,authorization:'Bearer '+config.token,'content-type':'application/json'},body:'{}'});await oldToken.body?.cancel();need(oldToken.status===401,'E2E_CP_OLD_TOKEN');mark('old-token-rejected');
  const retry=await api.request('submit',{id:signed.id,confirmation:hash});need(retry.status===400&&retry.data.error==='INJECTIVE_RESUBMISSION_FORBIDDEN','E2E_CP_RESEND');mark('resend-forbidden');
  const reconciled=ok(await api.request('reconcile',{id:signed.id})),included=mode==='after-inclusion';
  need(reconciled.state===(included?'reported-confirmed':'broadcast-unknown'),'E2E_CP_RESULT');mark('stored-hash-only-reconciliation');
  const after=await state();need(BigInt(after.sequence)-BigInt(before.sequence)===(included?1n:0n)&&BigInt(before.base)-BigInt(after.base)===(included?BigInt(AMOUNT):0n)&&BigInt(before.gas)-BigInt(after.gas)===(included?BigInt(FEE):0n)&&after.exchange===(included?AMOUNT:'0'),'E2E_CP_ACCOUNTING');mark('exact-balance-fee-sequence');
  let restore={tested:false},browserResult={passed:false,error:'not-run'};
  if(included){
   const latest=ok(await api.call('backup',{})).encrypted,currentHash=sha(latest),witnessBefore=sha(fs.readFileSync(path.join(cp,'checkpoint.json')));
   await close(next);next=null;
   fs.writeFileSync(path.join(home,'vault.json'),oldCipher);
   const bad=open(home,cp);try{await bad.send('start',{home,checkpoint:cp,chainOrigin:chain.rest,password,create:false});throw Error('E2E_CP_ROLLBACK_ALLOWED');}catch(e){need(e.message==='E2E_CP_CIPHERTEXT_MISMATCH','E2E_CP_ROLLBACK_ERROR');}finally{await close(bad);}
   need(sha(fs.readFileSync(path.join(cp,'checkpoint.json')))===witnessBefore,'E2E_CP_WITNESS_MUTATED');mark('old-vault-rejected-before-unlock');
   // Fault setup removes only the deliberately damaged Vault body; both original locks/witness stay.
   fs.unlinkSync(path.join(home,'vault.json'));restoreHost=open(home,cp);
   const restoredConfig=await restoreHost.send('start',{home,checkpoint:cp,chainOrigin:chain.rest,create:false});await api.open(restoredConfig);
   const wrong=await api.call('restore',{encrypted:oldCipher,password});need(wrong.status===400&&wrong.data.error==='CP_BACKUP_NOT_CURRENT'&&!fs.existsSync(path.join(home,'vault.json')),'E2E_CP_OLD_BACKUP');mark('old-backup-cannot-restore');
   const exact=ok(await api.call('restore',{encrypted:latest,password}));need(exact.exactCheckpointRestore===true&&exact.locked,'E2E_CP_RESTORE_API');
   need(sha(fs.readFileSync(path.join(home,'vault.json')))===currentHash&&sha(fs.readFileSync(path.join(cp,'checkpoint.json')))===witnessBefore,'E2E_CP_RESTORE_IDENTITY');mark('exact-current-backup-restored-through-owner-api');
   ok(await api.call('unlock',{password}));
   const r=await restoreHost.send('snapshot',{});need(r.transmissions===0&&r.records[0].hash===hash&&r.records[0].signedSha256===sigHash&&r.records[0].state==='reported-confirmed','E2E_CP_RESTORE_NO_SEND');mark('restored-history-retained-no-send');
   restore={tested:true,oldRejected:true,currentCiphertextMatched:true,checkpointUnchanged:true,signaturesPreserved:true,transmissions:0};
   browserResult=await browser(restoredConfig,output);
  }
  return {mode,checks,hash,amountAtomic:AMOUNT,feeAtomic:FEE,before,after,ownerSubmissions:included?1:0,restartedSubmissions:0,finalState:reconciled.state,
   sameDirectory:true,permanentLocksRetained:true,vaultCopiedToDifferentDirectory:false,checkpointReset:false,storageRecoveryPerformed:snap.protection.recoveryPerformed,
   protectionScheme:snap.protection.scheme,pairId:snap.protection.pairId,restore,browser:browserResult};
 }catch(e){primary=e;throw e;}
 finally{await cleanupAll(primary,[()=>api.close(),()=>close(restoreHost),()=>close(next),async()=>{
  if(h?.exit?.signal==='SIGKILL'){try{await h.close();}catch(e){need(e.message==='E2E_CHILD_EXIT','E2E_CP_CLOSE');}}else await close(h);
 },()=>fs.rmSync(home,{recursive:true,force:true}),()=>fs.rmSync(cp,{recursive:true,force:true})]);}
}
export async function runProtectedRecovery({onStep=()=>{},output}){
 const secrets=Array.from({length:3},()=>randomBytes(32).toString('hex'));let chain,primary;
 try{
  chain=await startInjective({actorSecretHexes:secrets});const cases=[];
  for(const [i,mode] of ['before-request','after-inclusion','save-intent'].entries())
   cases.push(await one({chain,actorIndex:i,secret:secrets[i],mode,onStep,output}));
  return {schema:'realdex.protected-recovery.v1',status:'passed',cases,checkCount:cases.reduce((n,x)=>n+x.checks.length,0),ownerSubmissions:1,restartedSubmissions:0,
   scheme:'realdex.vault-checkpoint-lease.v1',legacyInj13Compatible:false,jointRollbackDetected:false,publicNetwork:false,productionReady:false,powerLossTested:false};
 }catch(e){primary=e;throw e;}finally{await cleanupAll(primary,[()=>chain?.close()]);}
}
