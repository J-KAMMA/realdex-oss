/** Actual owner deposit + withdrawal, crash recovery and optional real-browser round trip. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {PrivateStore} from '../../wallet/lib/storage.mjs';import {Vault} from '../../wallet/lib/vault.mjs';import {WalletServer} from '../../wallet/lib/server.mjs';
import {startInjective} from './fixture.mjs';
const PASSWORD='public INJ08 disposable runtime fixture password',SECRET='46'.repeat(32),FEE=500000000000000n;
async function wait(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('INJ08_WAIT_TIMEOUT');}
test('INJ08 owner-funded exchange lifecycle on the real pinned node',async t=>{
 const chain=await startInjective({actorSecretHexes:[SECRET]});t.after(()=>chain.close());
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'inj08-owner-'));let app,store=new PrivateStore(home),vault=new Vault(store),start;
 t.after(async()=>{try{await app?.close();}finally{fs.rmSync(home,{recursive:true,force:true});}});
 await vault.create(PASSWORD);const account=await vault.addAccount({family:'evm',label:'Disposable INJ08 owner',secretHex:SECRET});const backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
 async function open(){app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]}});start=await app.start(0);}await open();
 const call=async(route,body={})=>{const r=await fetch(start.origin+'/api/'+route,{method:'POST',headers:{origin:start.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json'},body:JSON.stringify(body)}),v=await r.json();if(!r.ok)throw Error(v.error);return v;};
 const owner=chain.actors[0],sub=owner.subaccountId.slice(0,-1)+'1';
 const policy={gasLimit:'1000000',gasPriceAtomic:'500000000',maxGasFeeAtomic:String(FEE),gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000};
 const request=(key,amount,denom='ubase',over={})=>({accountId:account.id,payment:{requestKey:key,endpoint:chain.rest,subaccountId:sub,denom,amountAtomic:amount,policy:{...policy,...over}}});
 const prepare=(key,amount,denom,over)=>call('non-evm/injective/deposit/prepare',request(key,amount,denom,over));
 const approve=async p=>(await call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256,broadcast:false})).record;
 const submit=r=>call('non-evm/injective/submit',{id:r.id,confirmation:r.signed.requestId});
 const bank=async denom=>BigInt((await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+owner.address+'/by_denom?denom='+denom)).balance.amount);
 const seq=async()=>(await chain.get('/cosmos/auth/v1beta1/accounts/'+owner.address)).account.base_account.sequence;
 const txs=[];let count=0,sends=0;const check=(name,fn)=>t.test(name,async()=>{await fn();count++;});
 const track=()=>{const real=app.nonEvm.injectiveEngine.fetchImpl;app.nonEvm.injectiveEngine.fetchImpl=async(u,o)=>{if(o.method==='POST'&&u.endsWith('/cosmos/tx/v1beta1/txs'))sends++;return real(u,o);};};track();
 const included=async(r,phase)=>{const tx=await chain.included(r.signed.requestId);assert.equal(tx.code,0,tx.raw_log);txs.push({phase,hash:tx.txhash,height:tx.height,code:tx.code});return call('non-evm/injective/reconcile',{id:r.id});};
 const baseBefore=await bank('ubase'),gasBefore=await bank('inj');let deposit,retired;
 await check('Excess bank deposit and INJ plus gas one-atom excess fail before signature/history',async()=>{
  const n=await seq();await assert.rejects(prepare('excess-base',String(baseBefore+1n)),/INSUFFICIENT/);
  await assert.rejects(prepare('excess-gas',String(gasBefore-FEE+1n),'inj'),/INSUFFICIENT_WITH_GAS/);
  assert.equal((await vault.injectiveRecords()).length,0);assert.equal(await seq(),n);assert.equal(sends,0);
 });
 await check('Empty own subaccount accepts a bank-funded review; approval stores without sending',async()=>{
  const n=await seq(),p=await prepare('deposit-base','750000000000000000');assert.equal(p.summary.review.state.availableAtomic,'0');assert.equal(p.summary.destination,sub);assert.equal(p.summary.action,'deposit');
  deposit=await approve(p);assert.equal(deposit.state,'signed');assert.equal(sends,0);assert.equal(await seq(),n);
 });
 await check('Owner deposit really moves base bank funds into the nondefault exchange account',async()=>{
  assert.equal((await submit(deposit)).state,'broadcast');const r=await included(deposit,'owner-base-deposit');assert.equal(sends,1);
  assert.equal(r.report.actionEffect.availableAtomic,'750000000000000000');assert.equal(r.report.actionEffect.totalAtomic,'750000000000000000');assert.equal(r.report.actionEffect.bankBalanceAtomic,String(baseBefore-750000000000000000n));assert.equal(await bank('inj'),gasBefore-FEE);
 });
 await check('Actual INJ deposit debits amount plus fee from bank, not from exchange credit',async()=>{
  const before=await bank('inj'),r=await approve(await prepare('deposit-inj','1000000000000000','inj'));await submit(r);const final=await included(r,'owner-inj-deposit');
  assert.equal(final.report.actionEffect.availableAtomic,'1000000000000000');assert.equal(await bank('inj'),before-1000000000000000n-FEE);
 });
 await check('Same owner withdraws INJ through existing product API with no third-party destination',async()=>{
  const p=await call('non-evm/injective/withdraw/prepare',request('withdraw-inj','1000000000000000','inj'));assert.equal(p.summary.destination,owner.address);
  const r=await approve(p);await submit(r);const final=await included(r,'owner-inj-withdraw');assert.equal(final.report.actionEffect.availableAtomic,'0');assert.equal(await bank('inj'),gasBefore-3n*FEE);
 });
 await check('Dropped deposit response stays unknown after exactly one send',async()=>{
  deposit=await approve(await prepare('deposit-lost','250000000000000000'));const original=app.nonEvm.injectiveEngine.fetchImpl,before=sends;
  app.nonEvm.injectiveEngine.fetchImpl=async(u,o)=>{const result=await original(u,o);if(o.method==='POST'&&u.endsWith('/cosmos/tx/v1beta1/txs')){await result.arrayBuffer();throw Error('INTENTIONAL_RESPONSE_LOSS');}return result;};
  assert.equal((await submit(deposit)).state,'broadcast-unknown');assert.equal(sends,before+1);const receipt=await chain.included(deposit.signed.requestId);assert.equal(receipt.code,0);txs.push({phase:'deposit-lost-response',hash:receipt.txhash,height:receipt.height,code:receipt.code});await assert.rejects(submit(deposit),/RESUBMISSION/);
 });
 await check('Fresh process restores unknown deposit, never resends, and observes exact stored hash',async()=>{
  await app.close();app=null;
  const code=`import {PrivateStore} from ${JSON.stringify(new URL('../../wallet/lib/storage.mjs',import.meta.url).href)};
import {Vault} from ${JSON.stringify(new URL('../../wallet/lib/vault.mjs',import.meta.url).href)};
import {InjectiveOwnerEngine} from ${JSON.stringify(new URL('../../wallet/injective/engine.mjs',import.meta.url).href)};
const s=new PrivateStore(process.argv[1]),v=new Vault(s);await v.unlock(${JSON.stringify(PASSWORD)});const e=new InjectiveOwnerEngine(),r=(await v.injectiveRecords()).find(x=>x.id===process.argv[2]);let failure;try{await e.broadcast(v,r);}catch(x){failure=x.message;}const f=await e.reconcile(v,r);console.log(JSON.stringify({failure,state:f.state,hash:f.signed.requestId,effect:f.report.actionEffect}));await v.lock();s.close();`;
  const run=spawnSync(process.execPath,['--input-type=module','-e',code,home,deposit.id],{encoding:'utf8',timeout:30000});assert.equal(run.status,0,run.stderr);const restored=JSON.parse(run.stdout);assert.equal(restored.failure,'INJECTIVE_RESUBMISSION_FORBIDDEN');assert.equal(restored.state,'reported-confirmed');assert.equal(restored.hash,deposit.signed.requestId);assert.equal(restored.effect.kind,'deposit');assert.equal(restored.effect.availableAtomic,'1000000000000000000');
  store=new PrivateStore(home);vault=new Vault(store);await vault.unlock(PASSWORD);await open();track();
 });
 await check('Unsent deposit can retire only after its signed timeout, retaining original bytes',async()=>{
  const r=await approve(await prepare('expired-deposit','1','ubase',{timeoutBlocks:5}));await assert.rejects(call('non-evm/injective/recovery/prepare',{id:r.id}),/NOT_EXPIRED/);
  await wait(async()=>BigInt((await chain.get('/cosmos/base/tendermint/v1beta1/blocks/latest')).block.header.height)>BigInt(r.summary.timeoutHeight));
  const p=await call('non-evm/injective/recovery/prepare',{id:r.id}),before=sends;
  retired=await call('non-evm/injective/recovery/retire',{id:r.id,review:p,confirmation:p.reviewSha256,transactionHash:r.signed.requestId});
  assert.equal(retired.state,'retired-unsent-expired');assert.deepEqual(retired.signed,r.signed);assert.equal(sends,before);assert.equal(await bank('ubase'),baseBefore-1000000000000000000n);
 });
 await check('Freshly approved deposit after retirement reuses sequence safely; old bytes remain unsendable',async()=>{
  const fresh=await approve(await prepare('fresh-after-retired','1'));assert.equal(fresh.summary.sequenceKey,retired.summary.sequenceKey);assert.notEqual(fresh.signed.requestId,retired.signed.requestId);
  await assert.rejects(submit(retired),/RESUBMISSION|REVIEW_EXPIRED/);await submit(fresh);await included(fresh,'replacement-deposit');assert.equal(await bank('ubase'),baseBefore-1000000000000000001n);assert.equal(await bank('inj'),gasBefore-5n*FEE);
 });
 let browser=null;
 if(process.env.REALDEX_INJ08_BROWSER==='1')await check('Actual Chromium owner UI performs deposit and withdrawal against this same real node',async()=>{
  const config={origin:start.origin,rest:chain.rest,token:app.uiToken,address:owner.address,subaccountId:sub,...(process.env.REALDEX_INJ08_SCREENSHOT?{screenshot:process.env.REALDEX_INJ08_SCREENSHOT}:{})};
  const outcome=await new Promise((resolve,reject)=>{const p=spawn('python3',[new URL('./browser-owner-deposit.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('INJ08_BROWSER_TIMEOUT'));},90000);p.stdin.end(JSON.stringify(config));p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',(status,signal)=>{clearTimeout(timer);resolve({status,signal,out,err});});});
  assert.equal(outcome.status,0,outcome.err);assert.equal(outcome.signal,null);browser=JSON.parse(outcome.out);assert.equal(browser.passed,true);assert.equal(browser.transactions.length,2);assert.equal(browser.mode,'actual-browser-wallet-server-local-node');
  assert.equal(await bank('ubase'),baseBefore-1000000000000000001n);assert.equal(await bank('inj'),gasBefore-7n*FEE);assert.equal(sends,7);
 });
 if(process.env.REALDEX_INJ08_EVIDENCE){const git=x=>execFileSync('git',['rev-parse',x],{encoding:'utf8'}).trim();fs.writeFileSync(process.env.REALDEX_INJ08_EVIDENCE,JSON.stringify({schema:'realdex.inj08-real-owner-deposit.v1',passed:true,commit:git('HEAD'),tree:git('HEAD^{tree}'),gitTreeClean:execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim()==='',createdAt:new Date().toISOString(),nodeVersion:process.versions.node,version:chain.version,subchecks:count,transactions:txs,browser,sends,publicNetwork:false,productionReady:false},null,2)+'\n',{flag:'wx',mode:0o600});}
});
