/** UP02 real owner HTTP + checkpoint store + local Injective. All actors/funds disposable. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startInjective} from '../injective/fixture.mjs';
import {ApiDriver,PipeDriver} from '../owner-e2e/drivers.mjs';
import {sha,need,cleanupAll} from '../owner-e2e/protocol.mjs';
import {canonical} from '../../wallet/lib/guard.mjs';
const AMOUNT='1000000000000000000',FEE='500000000000000';
const policy={gasLimit:'1000000',gasPriceAtomic:'500000000',maxGasFeeAtomic:FEE,gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000};
const config={schema:'realdex.wallet-settings.v1',allowedAppOrigins:['http://localhost:42424'],networks:[{chainId:'31337',name:'Owner-approved fixture network',symbol:'ETH',rpcUrls:['http://127.0.0.1:8545/','http://127.0.0.1:8546/'],genesisHash:'0x'+'ab'.repeat(32),broadcastEnabled:false,contracts:[],maxFeeWei:'1000000',maxSlippageBps:0}]};
const ok=r=>{need(r?.status===200&&r.data&&!r.data.error,'E2E_UP02_OWNER_API');return r.data;};
async function close(host){if(!host)return;try{if(!host.failure&&!host.exit)await host.send('stop',{});}finally{await host.close();}}
export async function runSettingsLifecycle({onStep=()=>{}}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-vault-')),cp=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-witness-'));
 const secret=randomBytes(32).toString('hex'),password='UP02 disposable '+randomBytes(20).toString('hex'),api=new ApiDriver();
 let chain,host,connection,primary;const checks=[],mark=x=>{checks.push(x);onStep(x);};
 const start=async(enroll=false)=>{
  host=new PipeDriver({command:'python3',args:['-I','-S',fileURLToPath(new URL('./test-launch.py',import.meta.url)),home,cp,enroll?'yes':'no','host'],timeoutMs:60000});
  connection=await host.send('start',{home,checkpoint:cp,chainOrigin:chain.rest,create:enroll,...(enroll?{password,secretHex:secret}:{})});await api.open(connection);
 };
 const checkpoint=()=>JSON.parse(fs.readFileSync(path.join(cp,'checkpoint.json')));
 const fingerprint=()=>({vault:sha(fs.readFileSync(path.join(home,'vault.json'))),checkpoint:sha(fs.readFileSync(path.join(cp,'checkpoint.json')))});
 const reviewApply=async next=>{
  const original=fingerprint(),p=ok(await api.call('protected/settings/prepare',{settings:next}));need(canonical(original)===canonical(fingerprint()),'E2E_UP02_PREP_WROTE');
  const failed=await api.call('protected/settings/apply',{id:p.id,reviewSha256:'a'.repeat(64),confirmation:'SAVE SETTINGS AND LOCK'});need(failed.status===400&&failed.data.error==='CP_SETTINGS_CONFIRMATION'&&canonical(original)===canonical(fingerprint()),'E2E_UP02_BAD_REVIEW');
  const result=ok(await api.call('protected/settings/apply',{id:p.id,reviewSha256:p.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK'}));need(result.locked===true&&result.changed===true,'E2E_UP02_APPLY');return result;
 };
 try{
  chain=await startInjective({actorSecretHexes:[secret]});await start(true);const accountId=connection.accountId,owner=chain.actors[0],sub=owner.subaccountId.slice(0,-1)+'1';
  const locks=[home,cp].map(d=>fs.statSync(path.join(d,'writer.lock')).ino),pairId=checkpoint().pairId;
  const state=async()=>({gas:(await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+owner.address+'/by_denom?denom=inj')).balance.amount,
   base:(await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+owner.address+'/by_denom?denom=ubase')).balance.amount,
   sequence:(await chain.get('/cosmos/auth/v1beta1/accounts/'+owner.address)).account.base_account.sequence});
  const before=await state(),initialGeneration=checkpoint().generation;
  need(ok(await api.call('protected/settings',{})).revision===0,'E2E_UP02_INITIAL');mark('empty-settings-before-first-review');
  const first=await reviewApply(config);need(first.revision===1,'E2E_UP02_REVISION');mark('read-only-review-and-wrong-hash-rejected');mark('one-reviewed-ciphertext-commit');
  const locked=ok(await api.call('status',{}));need(locked.locked&&locked.protectedSettings.loaded===false&&locked.networks.length===0&&locked.allowedAppOrigins.length===0,'E2E_UP02_LOCKED_SETTINGS');mark('saved-settings-hidden-while-locked');
  ok(await api.call('unlock',{password}));const loaded=ok(await api.call('protected/settings',{}));need(canonical(loaded.settings)===canonical(config)&&loaded.revision===1,'E2E_UP02_RELOAD');mark('decrypt-restores-exact-owner-configuration');
  const old=connection;const beforeRestart=fingerprint();await close(host);host=null;await start();
  need(connection.token!==old.token&&connection.pid!==old.pid&&canonical(beforeRestart)===canonical(fingerprint()),'E2E_UP02_RESTART');
  need(ok(await api.call('status',{})).protectedSettings.loaded===false,'E2E_UP02_PRE_UNLOCK');mark('same-pair-restart-does-not-rewrite-or-load-settings');
  const denied=await fetch(connection.origin+'/api/status',{method:'POST',headers:{origin:connection.origin,authorization:'Bearer '+old.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});await denied.body?.cancel();need(denied.status===401,'E2E_UP02_OLD_TOKEN');mark('old-owner-token-rejected');
  ok(await api.call('unlock',{password}));need(ok(await api.call('protected/settings',{})).settingsSha256===loaded.settingsSha256,'E2E_UP02_SETTINGS_DIGEST');mark('settings-digest-survives-process-restart');
  need((await host.send('stats',{})).ownerSends===0&&canonical(await state())===canonical(before),'E2E_UP02_CONFIG_SEND');mark('configuration-alone-sends-no-transaction');
  const prep=ok(await api.request('prepare',{kind:'deposit',body:{accountId,payment:{requestKey:'up02-config-deposit',endpoint:chain.rest,subaccountId:sub,denom:'ubase',amountAtomic:AMOUNT,policy}}}));
  const signed=ok(await api.request('approve',{id:prep.id,intentId:prep.intentId,confirmation:prep.summary.reviewSha256})).record;
  const blockedChange={...config,allowedAppOrigins:[]},saved=fingerprint();
  const blocked=await api.call('protected/settings/prepare',{settings:blockedChange});need(blocked.status===400&&blocked.data.error==='CP_SETTINGS_UNRESOLVED_TRANSACTION'&&canonical(saved)===canonical(fingerprint()),'E2E_UP02_SIGNED_GUARD');mark('signed-operation-blocks-configuration-mutation');
  await host.send('drop-next',{});need(ok(await api.request('submit',{id:signed.id,confirmation:signed.signed.requestId})).state==='broadcast-unknown','E2E_UP02_LOST_RESPONSE');
  const receipt=await chain.included(signed.signed.requestId);need(receipt.code===0,'E2E_UP02_INCLUDED');
  const unknown=await api.call('protected/settings/prepare',{settings:blockedChange});need(unknown.status===400&&unknown.data.error==='CP_SETTINGS_UNRESOLVED_TRANSACTION','E2E_UP02_UNKNOWN_GUARD');mark('unknown-submission-does-not-unlock-settings');
  const sent=await host.send('stats',{});need(sent.ownerSends===1,'E2E_UP02_SEND_COUNT');await close(host);host=null;await start();ok(await api.call('unlock',{password}));
  need(ok(await api.call('protected/settings',{})).settingsSha256===loaded.settingsSha256,'E2E_UP02_UNKNOWN_RESTART_SETTINGS');mark('settings-and-unknown-history-recover-together');
  const found=ok(await api.request('reconcile',{id:signed.id}));need(found.state==='reported-confirmed'&&found.signed.requestId===signed.signed.requestId&&(await host.send('stats',{})).ownerSends===0,'E2E_UP02_RECONCILE');mark('saved-hash-reconciled-without-resend');
  const second=await reviewApply(blockedChange);need(second.revision===2,'E2E_UP02_SECOND_CONFIG');ok(await api.call('unlock',{password}));need(canonical(ok(await api.call('protected/settings',{})).settings)===canonical(blockedChange),'E2E_UP02_SECOND_LOADED');mark('resolved-history-allows-separate-owner-settings-approval');
  const history=ok(await api.call('non-evm/history',{}));need(history.records.length===1&&history.records[0].signed.requestId===signed.signed.requestId,'E2E_UP02_HISTORY_RETAINED');mark('configuration-does-not-delete-signed-history');
  const after=await state();need(BigInt(before.base)-BigInt(after.base)===BigInt(AMOUNT)&&BigInt(before.gas)-BigInt(after.gas)===BigInt(FEE)&&BigInt(after.sequence)-BigInt(before.sequence)===1n,'E2E_UP02_BALANCES');mark('one-deposit-one-fee-one-sequence');
  need([home,cp].every((d,i)=>fs.statSync(path.join(d,'writer.lock')).ino===locks[i])&&checkpoint().pairId===pairId,'E2E_UP02_PAIR_CHANGED');mark('both-permanent-locks-and-pair-retained');
  return {schema:'realdex.up02-settings-lifecycle.v1',passed:true,checks,before,after,amountAtomic:AMOUNT,feeAtomic:FEE,ownerSubmissions:1,restartedSubmissions:0,configurationRevisions:[1,2],settingsDigestBeforeRestart:loaded.settingsSha256,
   initialGeneration,finalGeneration:checkpoint().generation,sameDirectories:true,permanentLocksRetained:true,syntheticResponses:0,publicNetwork:false,browserTested:false,independentStateProof:false,productionReady:false};
 }catch(e){primary=e;throw e;}finally{await cleanupAll(primary,[()=>api.close(),()=>close(host),()=>chain?.close(),()=>fs.rmSync(home,{recursive:true,force:true}),()=>fs.rmSync(cp,{recursive:true,force:true})]);}
}
