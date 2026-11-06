/** Actual isolated Injective node. All keys/funds disposable; no public RPC.
 * HTTP500 remains unknown; no production parsing of a rejection error message.
 */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {startInjective,waitFor} from './fixture.mjs';
import {PrivateStore} from '../../wallet/lib/storage.mjs';import {Vault} from '../../wallet/lib/vault.mjs';import {WalletServer} from '../../wallet/lib/server.mjs';
import {SUBMISSION_EXPIRED} from '../../wallet/injective/retirement.mjs';
const PASSWORD='public INJ10 disposable diagnostic password',SECRET='47'.repeat(32),FEE=500000000000000n;
test('INJ10 owner-approved submitted-expiry barrier on the fixed real node',async t=>{
 const chain=await startInjective({actorSecretHexes:[SECRET]});t.after(()=>chain.close());
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inj10-owner-'));let app,store=new PrivateStore(dir),vault=new Vault(store),started;
 t.after(async()=>{try{await app?.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
 await vault.create(PASSWORD);const owner=await vault.addAccount({family:'evm',label:'INJ10 disposable owner',secretHex:SECRET});const backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
 const actor=chain.actors[0],sub=actor.subaccountId.slice(0,-1)+'1';let attempts=0,sends=0,hold=false,drop=false;const http=[],included=[];
 async function open(){
  app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]}});started=await app.start(0);
  const real=app.nonEvm.injectiveEngine.fetchImpl;
  app.nonEvm.injectiveEngine.fetchImpl=async(u,o)=>{
   if(o.method==='POST'&&u.endsWith('/cosmos/tx/v1beta1/txs')){attempts++;if(hold){hold=false;throw Error('INJ10_CUT_BEFORE_WRITE');}sends++;const r=await real(u,o),raw=await r.clone().json();
    http.push({status:r.status,code:raw.code??raw.tx_response?.code,lowFeeMessage:typeof raw.message==='string'&&raw.message.includes('insufficient fee')});
    if(drop){drop=false;await r.arrayBuffer();throw Error('INJ10_LOST_RESPONSE');}return r;
   }return real(u,o);
  };
 }await open();
 const call=async(route,body)=>{const r=await fetch(started.origin+'/api/'+route,{method:'POST',headers:{origin:started.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json'},body:JSON.stringify(body)}),d=await r.json();if(!r.ok)throw Error(d.error);return d;};
 const bank=async denom=>BigInt((await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+actor.address+'/by_denom?denom='+denom)).balance.amount);
 const seq=async()=>(await chain.get('/cosmos/auth/v1beta1/accounts/'+actor.address)).account.base_account.sequence;
 const prepare=(kind,key,amount,{low=false,blocks=8}={})=>call('non-evm/injective/'+kind+'/prepare',{accountId:owner.id,payment:{requestKey:key,endpoint:chain.rest,subaccountId:sub,denom:'ubase',amountAtomic:amount,policy:{gasLimit:'1000000',gasPriceAtomic:low?'0.000000000000000001':'500000000',maxGasFeeAtomic:low?'1':String(FEE),gasMarginBps:12500,timeoutBlocks:blocks,maxAgeMs:30000}}});
 const sign=async p=>(await call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256,broadcast:false})).record;
 const submit=r=>call('non-evm/injective/submit',{id:r.id,confirmation:r.signed.requestId});
 const proposal=r=>call('non-evm/injective/recovery/prepare',{id:r.id});
 const retire=(r,p)=>call('non-evm/injective/recovery/retire',{id:r.id,review:p,confirmation:p.reviewSha256,transactionHash:r.signed.requestId});
 const expired=r=>waitFor(async()=>{const b=await chain.get('/cosmos/base/tendermint/v1beta1/blocks/latest');return BigInt((b.block??b.sdk_block).header.height)>BigInt(r.summary.timeoutHeight);},30000);
 const confirm=async(r,phase)=>{const tx=await chain.included(r.signed.requestId);assert.equal(tx.code,0,tx.raw_log);included.push({phase,hash:tx.txhash,height:tx.height,code:tx.code});return call('non-evm/injective/reconcile',{id:r.id});};
 const startSeq=await seq(),startGas=await bank('inj'),startBase=await bank('ubase');let lowFee,lowRetired,validHeld,heldRetired,lost,checks=0;
 const check=async(name,fn)=>{let ok=false;await t.test(name,async()=>{await fn();checks++;ok=true;});assert.ok(ok,'INJ10_STOP_AFTER_FAILURE');};
 await check('Real simulation accepts low fee review, but ownership/cap and stored bytes remain exact',async()=>{
  lowFee=await sign(await prepare('deposit','fee-too-low','1000000000000000000',{low:true}));assert.equal(lowFee.state,'signed');assert.equal(lowFee.summary.feeAtomic,'1');assert.equal(await seq(),startSeq);assert.equal(attempts,0);
 });
 await check('Actual HTTP500 fee rejection stays broadcast-unknown after exactly one attempt',async()=>{
  lowFee=await submit(lowFee);assert.equal(lowFee.state,'broadcast-unknown');assert.equal(lowFee.report.reason,'SUBMISSION_STARTING');assert.equal(attempts,1);assert.equal(sends,1);assert.equal(http[0].status,500);assert.equal(http[0].lowFeeMessage,true);
  assert.equal(await seq(),startSeq);assert.equal(await bank('inj'),startGas);await assert.rejects(submit(lowFee),/RESUBMISSION/);assert.equal(attempts,1);
 });
 await check('A missing transaction alone cannot release the old signed sequence before its timeout',async()=>{
  await assert.rejects(proposal(lowFee),/NOT_EXPIRED/);await assert.rejects(prepare('deposit','cannot-skip-old','1'),/UNRESOLVED/);assert.equal(sends,1);
 });
 await check('After signed timeout, read-only evidence retains submission possibility; wrong owner hash still refuses',async()=>{
  await expired(lowFee);const before=store.read(),p=await proposal(lowFee);assert.equal(store.read(),before);assert.equal(p.neverSubmittedByWallet,false);assert.equal(p.submissionMayHaveOccurred,true);assert.equal(p.originalState,'broadcast-unknown');assert.equal(p.evidence.sequence,startSeq);
  await assert.rejects(call('non-evm/injective/recovery/retire',{id:lowFee.id,review:p,confirmation:'wrong',transactionHash:lowFee.signed.requestId}),/CONFIRMATION/);
  lowRetired=await retire(lowFee,p);assert.equal(lowRetired.state,SUBMISSION_EXPIRED);assert.deepEqual(lowRetired.report,lowFee.report);assert.deepEqual(lowRetired.signed,lowFee.signed);assert.equal(sends,1);
 });
 await check('Fresh OS process decrypts submission-expiry history and cannot resend old bytes',async()=>{
  await app.close();app=null;
  const code=`import {PrivateStore} from ${JSON.stringify(new URL('../../wallet/lib/storage.mjs',import.meta.url).href)};import {Vault} from ${JSON.stringify(new URL('../../wallet/lib/vault.mjs',import.meta.url).href)};import {InjectiveOwnerEngine} from ${JSON.stringify(new URL('../../wallet/injective/engine.mjs',import.meta.url).href)};
const store=new PrivateStore(process.argv[1]),v=new Vault(store);await v.unlock(${JSON.stringify(PASSWORD)});const r=(await v.injectiveRecords())[0];let calls=0,error;try{await new InjectiveOwnerEngine({fetchImpl:()=>{calls++;throw Error('NO_NETWORK');}}).broadcast(v,r);}catch(e){error=e.message;}console.log(JSON.stringify({state:r.state,raw:r.signed.txRawBase64,prior:r.retirement.review.originalState,never:r.retirement.review.neverSubmittedByWallet,error,calls}));await v.lock();store.close();`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code,dir],{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);const d=JSON.parse(r.stdout);assert.equal(d.state,SUBMISSION_EXPIRED);assert.equal(d.prior,'broadcast-unknown');assert.equal(d.never,false);assert.equal(d.raw,lowFee.signed.txRawBase64);assert.equal(d.calls,0);assert.match(d.error,/RESUBMISSION|EXPIRED/);
  store=new PrivateStore(dir);vault=new Vault(store);await vault.unlock(PASSWORD);await open();
 });
 await check('New owner approval with corrected fee reuses sequence once; deposit and one fee are included',async()=>{
  const r=await sign(await prepare('deposit','corrected-fee','1000000000000000000',{blocks:40}));assert.equal(r.summary.sequenceKey,lowFee.summary.sequenceKey);assert.notEqual(r.signed.requestId,lowFee.signed.requestId);
  await submit(r);const result=await confirm(r,'replacement-deposit');assert.equal(result.report.actionEffect.availableAtomic,'1000000000000000000');assert.equal(await seq(),String(BigInt(startSeq)+1n));assert.equal(await bank('inj'),startGas-FEE);assert.equal(await bank('ubase'),startBase-1000000000000000000n);assert.equal(sends,2);
 });
 await check('Valid-fee withdrawal cut at the transport boundary remains unknown, not silently unsent',async()=>{
  validHeld=await sign(await prepare('withdraw','cut-before-transport','500000000000000000'));hold=true;validHeld=await submit(validHeld);assert.equal(validHeld.state,'broadcast-unknown');assert.equal(attempts,3);assert.equal(sends,2);await assert.rejects(submit(validHeld),/RESUBMISSION/);await assert.rejects(proposal(validHeld),/NOT_EXPIRED/);
 });
 await check('Actual node rejects the valid-fee OLD raw transaction after signed timeout without charging or consuming sequence',async()=>{
  await expired(validHeld);const beforeSeq=await seq(),beforeGas=await bank('inj'),raw=await chain.broadcast(Buffer.from(validHeld.signed.txRawBase64,'base64')),refusal=raw.tx_response??raw;
  assert.notEqual(refusal.code,0);assert.match(refusal.raw_log??refusal.message,/timeout height|timed out|timeout/i);assert.equal(await seq(),beforeSeq);assert.equal(await bank('inj'),beforeGas);assert.equal(sends,2);
  heldRetired=await retire(validHeld,await proposal(validHeld));assert.equal(heldRetired.state,SUBMISSION_EXPIRED);assert.equal(heldRetired.retirement.review.neverSubmittedByWallet,false);
 });
 await check('Separate replacement withdrawal succeeds at the same sequence; old submitted record is immutable',async()=>{
  const r=await sign(await prepare('withdraw','new-reviewed-withdrawal','500000000000000000',{blocks:40}));assert.equal(r.summary.sequenceKey,validHeld.summary.sequenceKey);await submit(r);const result=await confirm(r,'replacement-withdrawal');assert.equal(result.report.actionEffect.availableAtomic,'500000000000000000');assert.equal(await bank('ubase'),startBase-500000000000000000n);assert.equal(await bank('inj'),startGas-2n*FEE);assert.equal(sends,3);
 });
 await check('Included transaction with dropped response cannot retire, even after its timeout',async()=>{
  lost=await sign(await prepare('deposit','included-response-lost','1'));drop=true;lost=await submit(lost);assert.equal(lost.state,'broadcast-unknown');const tx=await chain.included(lost.signed.requestId);assert.equal(tx.code,0);included.push({phase:'included-with-lost-response',hash:tx.txhash,height:tx.height,code:tx.code});await expired(lost);await assert.rejects(proposal(lost),/RECEIPT_AVAILABLE/);assert.equal(sends,4);
 });
 await check('Even hidden transaction lookup cannot bypass actual consumed sequence; restore lookup then reconcile without resend',async()=>{
  const engine=app.nonEvm.injectiveEngine,real=engine.fetchImpl;
  engine.fetchImpl=(u,o)=>u.endsWith('/txs/'+lost.signed.requestId)?Promise.resolve(new Response('{"code":5,"message":"diagnostic hidden result","details":[]}',{status:404,headers:{'content-type':'application/json'}})):real(u,o);
  const before=store.read();await assert.rejects(proposal(lost),/ACCOUNT_CHANGED/);assert.equal(store.read(),before);engine.fetchImpl=real;
  const r=await call('non-evm/injective/reconcile',{id:lost.id});assert.equal(r.state,'reported-confirmed');assert.equal(attempts,5);assert.equal(sends,4);assert.equal(await seq(),String(BigInt(startSeq)+3n));assert.equal(await bank('inj'),startGas-3n*FEE);
 });
 await check('All five encrypted records persist across reopen; no delete, refund, auto retry or replacement',async()=>{
  const before=await vault.injectiveRecords();assert.equal(before.length,5);await app.close();app=null;store=new PrivateStore(dir);vault=new Vault(store);await vault.unlock(PASSWORD);await open();assert.deepEqual(await vault.injectiveRecords(),before);
  for(const r of [lowFee,validHeld])await assert.rejects(submit(r),/RESUBMISSION|EXPIRED/);assert.equal(attempts,5);assert.equal(sends,4);
 });
 if(process.env.REALDEX_INJ10_EVIDENCE){const git=x=>execFileSync('git',['rev-parse',x],{encoding:'utf8'}).trim();fs.writeFileSync(process.env.REALDEX_INJ10_EVIDENCE,JSON.stringify({schema:'realdex.inj10-real-submission-expiry.v1',passed:true,subchecks:checks,commit:git('HEAD'),tree:git('HEAD^{tree}'),gitTreeClean:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()==='',nodeVersion:process.version,version:chain.version,publicNetwork:false,productionReady:false,walletAttempts:attempts,walletHttpSends:sends,diagnosticOldTimeoutSend:1,http,included,retiredRecords:2,sequenceAdvance:3,gasFeesCharged:String(3n*FEE)},null,2)+'\n',{flag:'wx'});}
});
