/** Real local node retirement: signed bytes time out, an owner separately authorizes replacement. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync,execFileSync} from 'node:child_process';
import {PrivateStore} from '../../wallet/lib/storage.mjs';import {Vault} from '../../wallet/lib/vault.mjs';import {WalletServer} from '../../wallet/lib/server.mjs';
import {preflightInjectiveLimitOrder} from '../../node/external/injective-preflight.mjs';
import {startInjective,orderRequest,waitFor,movement,localTransaction} from './fixture.mjs';
const PASSWORD='public INJ07 disposable fixture password',SECRET='46'.repeat(32),RETIRED='retired-unsent-expired';
test('INJ07 owner expiry recovery against actual Injective node',async t=>{
 const chain=await startInjective({actorSecretHexes:[SECRET]});t.after(()=>chain.close());
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inj07-owner-'));let app,owner,store,vault,start;let sent=0;const included=[];
 t.after(async()=>{try{await app?.close();}finally{fs.rmSync(dir,{force:true,recursive:true});}});
 async function open(create=false){store=new PrivateStore(dir);vault=new Vault(store);if(create){await vault.create(PASSWORD);owner=await vault.addAccount({family:'evm',label:'INJ07 disposable owner',secretHex:SECRET});const b=await vault.backup();await vault.verifyBackup(b.encrypted,PASSWORD);}else await vault.unlock(PASSWORD);
  app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]}});start=await app.start(0);
  const actual=app.nonEvm.injectiveEngine.fetchImpl;app.nonEvm.injectiveEngine.fetchImpl=(url,opt)=>{if(opt.method==='POST'&&url.endsWith('/cosmos/tx/v1beta1/txs'))sent++;return actual(url,opt);};
 }
 await open(true);
 const call=async(route,body={})=>{const r=await fetch(start.origin+'/api/'+route,{method:'POST',headers:{origin:start.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json'},body:JSON.stringify(body)}),v=await r.json();if(!r.ok)throw Error(v.error);return v;};
 const approve=async p=>(await call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256,broadcast:false})).record;
 const submit=r=>call('non-evm/injective/submit',{id:r.id,confirmation:r.signed.requestId});
 const inspect=r=>call('non-evm/injective/recovery/prepare',{id:r.id});
 const retire=(r,p)=>call('non-evm/injective/recovery/retire',{id:r.id,review:p,confirmation:p.reviewSha256,transactionHash:r.signed.requestId});
 const account=async()=>(await chain.get('/cosmos/auth/v1beta1/accounts/'+chain.actors[0].address)).account.base_account;
 const gas=async()=>BigInt((await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+chain.actors[0].address+'/by_denom?denom=inj')).balance.amount);
 const height=async()=>{const raw=await chain.get('/cosmos/base/tendermint/v1beta1/blocks/latest');return BigInt((raw.block??raw.sdk_block).header.height);};
 const waitExpired=async r=>waitFor(async()=>await height()>BigInt(r.summary.timeoutHeight),30000);
 let count=0;const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();count++;passed=true;});assert.ok(passed,'INJ07_SCENARIO_STOPPED');};
 const initial=await account(),initialGas=await gas();let old,recovered,next;
 await check('Sign a real order without submitting; early recovery is refused',async()=>{
  const req=await orderRequest(chain,0,{quantity:'1',requestKey:'old-never-sent'});req.policy.timeoutBlocks=20;
  const review=await preflightInjectiveLimitOrder(req);old=await approve(await call('non-evm/injective/prepare',{accountId:owner.id,review}));
  assert.equal(old.state,'signed');assert.equal(sent,0);await assert.rejects(inspect(old),/NOT_EXPIRED/);assert.equal((await account()).sequence,initial.sequence);
 });
 await check('Timeout must be exceeded; real-node recovery reads do not move funds or consume sequence',async()=>{
  await waitExpired(old);const dataBefore=store.read(),p=await inspect(old);assert.ok(BigInt(p.evidence.height)>BigInt(old.summary.timeoutHeight));assert.equal(store.read(),dataBefore);assert.equal(sent,0);assert.equal(await gas(),initialGas);
  recovered=await retire(old,p);assert.equal(recovered.state,RETIRED);assert.deepEqual(recovered.signed,old.signed);assert.equal(sent,0);assert.equal((await account()).sequence,initial.sequence);
 });
 await check('Old signed bytes are also rejected by the actual node after timeout',async()=>{
  // Diagnostic transmission only, outside the wallet; proves the recorded timeout is effective.
  const rejected=await chain.broadcast(Buffer.from(old.signed.txRawBase64,'base64'));
  const refusal=rejected.tx_response??rejected;assert.equal(typeof refusal.code,'number');assert.notEqual(refusal.code,0);assert.match(refusal.raw_log??refusal.message,/timeout height|timed out|timeout/i);
  assert.equal((await account()).sequence,initial.sequence);assert.equal(await gas(),initialGas);assert.equal(sent,0);
 });
 await check('Fresh process restores retirement, blocks old wallet send, and retains every signed byte',async()=>{
  await app.close();app=null;
  const code=`import {PrivateStore} from ${JSON.stringify(new URL('../../wallet/lib/storage.mjs',import.meta.url).href)};
import {Vault} from ${JSON.stringify(new URL('../../wallet/lib/vault.mjs',import.meta.url).href)};
import {InjectiveOwnerEngine} from ${JSON.stringify(new URL('../../wallet/injective/engine.mjs',import.meta.url).href)};
const store=new PrivateStore(process.argv[1]),v=new Vault(store);await v.unlock(${JSON.stringify(PASSWORD)});const r=(await v.injectiveRecords())[0];let calls=0,error;
try{await new InjectiveOwnerEngine({fetchImpl:()=>{calls++;throw Error('NETWORK_FORBIDDEN');}}).broadcast(v,r);}catch(e){error=e.message;}
console.log(JSON.stringify({state:r.state,raw:r.signed.txRawBase64,hash:r.signed.requestId,error,calls}));v.lock();store.close();`;
  const run=spawnSync(process.execPath,['--input-type=module','-e',code,dir],{encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stderr);const v=JSON.parse(run.stdout);
  assert.equal(v.state,RETIRED);assert.equal(v.raw,old.signed.txRawBase64);assert.equal(v.hash,old.signed.requestId);assert.equal(v.calls,0);assert.match(v.error,/RESUBMISSION|EXPIRED/);
  await open();
 });
 await check('A separate owner approval signs the new order at the same sequence; one send succeeds',async()=>{
  const req=await orderRequest(chain,0,{quantity:'0.25',requestKey:'new-after-retirement'}),review=await preflightInjectiveLimitOrder(req);
  next=await approve(await call('non-evm/injective/prepare',{accountId:owner.id,review}));assert.equal(next.summary.sequenceKey,old.summary.sequenceKey);assert.notEqual(next.signed.requestId,old.signed.requestId);assert.equal(sent,0);
  const result=await submit(next);assert.equal(result.state,'broadcast');assert.equal(sent,1);const r=await chain.included(next.signed.requestId);assert.equal(r.code,0,r.raw_log);included.push({phase:'replacement-order',hash:r.txhash,height:r.height,code:r.code});
  const final=await call('non-evm/injective/reconcile',{id:next.id});assert.equal(final.state,'reported-confirmed');assert.equal((await account()).sequence,String(BigInt(initial.sequence)+1n));assert.equal(await gas(),initialGas-500000000000000n);
 });
 let cancel;
 await check('Cancellation whose target fully fills is not discarded before its own timeout',async()=>{
  const orders=(await chain.get('/injective/exchange/v2/spot/orders/'+chain.market.market_id+'/'+chain.actors[0].subaccountId)).orders;assert.equal(orders.length,1);
  const {maxTradingFeeBps,...policy}=(await orderRequest(chain,0)).policy;policy.timeoutBlocks=20;
  cancel=await approve(await call('non-evm/injective/cancel/prepare',{accountId:owner.id,sourceRecordId:next.id,payment:{requestKey:'cancel-then-filled',orderHash:orders[0].order_hash,policy}}));
  const other=await preflightInjectiveLimitOrder(await orderRequest(chain,1,{side:'buy',quantity:'0.25',requestKey:'fixture-fill-quarter'}));const r=await chain.broadcast(chain.sign(other.transaction,1));const includedTx=await chain.included(r.tx_response.txhash);assert.equal(includedTx.code,0);included.push({phase:'fixture-counterparty-fill',hash:includedTx.txhash,height:includedTx.height,code:includedTx.code});
  await assert.rejects(submit(cancel),/NOT_OPEN/);assert.equal(sent,1);await assert.rejects(inspect(cancel),/NOT_EXPIRED/);
 });
 await check('After timeout, unsent cancellation is retired without changing already-filled balances',async()=>{
  const beforeGas=await gas(),beforeSequence=(await account()).sequence;
  await waitExpired(cancel);const retired=await retire(cancel,await inspect(cancel));assert.equal(retired.state,RETIRED);assert.equal((await account()).sequence,beforeSequence);assert.equal(await gas(),beforeGas);assert.equal(sent,1);
  assert.equal((await chain.get('/injective/exchange/v2/spot/orders/'+chain.market.market_id+'/'+chain.actors[0].subaccountId)).orders.length,0);
 });
 let withdraw;const sub=chain.actors[0].subaccountId.slice(0,-1)+'1';
 await check('Setup deposit and sign a self-withdrawal without submitting it',async()=>{
  const deposit=await localTransaction(chain,0,movement(chain,0,'Deposit',sub,'1000000000000000000')),r=await chain.broadcast(chain.sign(deposit,0));const inc=await chain.included(r.tx_response.txhash);assert.equal(inc.code,0);included.push({phase:'fixture-deposit',hash:inc.txhash,height:inc.height,code:inc.code});
  const {maxTradingFeeBps,...policy}=(await orderRequest(chain,0)).policy;policy.timeoutBlocks=20;
  withdraw=await approve(await call('non-evm/injective/withdraw/prepare',{accountId:owner.id,payment:{requestKey:'withdraw-never-sent',endpoint:chain.rest,subaccountId:sub,denom:'ubase',amountAtomic:'500000000000000000',policy}}));assert.equal(sent,1);
 });
 await check('Expired withdrawal is retired and replaced through a new review, never old bytes',async()=>{
  await waitExpired(withdraw);await retire(withdraw,await inspect(withdraw));
  const {maxTradingFeeBps,...policy}=(await orderRequest(chain,0)).policy;
  const fresh=await approve(await call('non-evm/injective/withdraw/prepare',{accountId:owner.id,payment:{requestKey:'withdraw-new-reviewed',endpoint:chain.rest,subaccountId:sub,denom:'ubase',amountAtomic:'500000000000000000',policy}}));assert.equal(fresh.summary.sequenceKey,withdraw.summary.sequenceKey);assert.notEqual(fresh.signed.requestId,withdraw.signed.requestId);
  await submit(fresh);assert.equal(sent,2);const r=await chain.included(fresh.signed.requestId);assert.equal(r.code,0);included.push({phase:'replacement-withdraw',hash:r.txhash,height:r.height,code:r.code});const final=await call('non-evm/injective/reconcile',{id:fresh.id});assert.equal(final.report.actionEffect.availableAtomic,'500000000000000000');
 });
 await check('All old records remain in encrypted history and cannot be reactivated after restart',async()=>{
  const before=await vault.injectiveRecords();await app.close();app=null;await open();assert.deepEqual(await vault.injectiveRecords(),before);
  for(const r of [old,cancel,withdraw]){assert.equal(before.find(x=>x.id===r.id).state,RETIRED);await assert.rejects(submit(r),/RESUBMISSION|EXPIRED/);}assert.equal(sent,2);assert.equal(before.length,5);
 });
 assert.equal(count,10);
 if(process.env.REALDEX_INJ07_EVIDENCE)fs.writeFileSync(process.env.REALDEX_INJ07_EVIDENCE,JSON.stringify({schema:'realdex.inj07-real-owner-recovery.v1',passed:true,subchecks:count,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),version:chain.version,publicNetwork:false,productionReady:false,walletSends:sent,diagnosticExpiredSend:1,included,retired:3,latestSequence:(await account()).sequence},null,2)+'\n',{flag:'wx'});
});
