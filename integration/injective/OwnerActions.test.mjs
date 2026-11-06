/** Real local Injective owner cancellation/withdrawal. No public chain, user key or external peer. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync,execFileSync} from 'node:child_process';
import {PrivateStore} from '../../wallet/lib/storage.mjs';import {Vault} from '../../wallet/lib/vault.mjs';import {WalletServer} from '../../wallet/lib/server.mjs';
import {preflightInjectiveLimitOrder} from '../../node/external/injective-preflight.mjs';
import {startInjective,orderRequest,localTransaction,movement} from './fixture.mjs';
const PASSWORD='public local INJ06 integration fixture password',SECRET='46'.repeat(32);
test('INJ06 real owner cancellation and durable self-withdrawal',async t=>{
 const chain=await startInjective({actorSecretHexes:[SECRET]});t.after(()=>chain.close());
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'inj06-owner-'));let app;
 t.after(async()=>{try{await app?.close();}finally{fs.rmSync(directory,{recursive:true,force:true});}});
 const store=new PrivateStore(directory),vault=new Vault(store);await vault.create(PASSWORD);
 const account=await vault.addAccount({family:'evm',label:'Disposable INJ06 owner',secretHex:SECRET}),backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
 app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]}});
 const start=await app.start(0);
 const call=async(route,body={})=>{const r=await fetch(start.origin+'/api/'+route,{method:'POST',headers:{origin:start.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json'},body:JSON.stringify(body)}),v=await r.json();if(!r.ok)throw Error(v.error);return v;};
 const approve=async p=>(await call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256,broadcast:false})).record;
 const submit=r=>call('non-evm/injective/submit',{id:r.id,confirmation:r.signed.requestId});
 const balance=async d=>(await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+chain.actors[0].address+'/by_denom?denom='+d)).balance.amount;
 const sequence=async()=>(await chain.get('/cosmos/auth/v1beta1/accounts/'+chain.actors[0].address)).account.base_account.sequence;
 const orders=async()=>(await chain.get('/injective/exchange/v2/spot/orders/'+chain.market.market_id+'/'+chain.actors[0].subaccountId)).orders;
 const initialBase=BigInt(await balance('ubase')),initialGas=BigInt(await balance('inj')),transactions=[];
 const record=(phase,r)=>{assert.equal(r.code,0,r.raw_log);transactions.push({phase,hash:r.txhash,height:r.height,code:r.code,gasWanted:r.gas_wanted,gasUsed:r.gas_used});return r;};
 const submitIncluded=async(r,phase)=>{const sent=await submit(r);assert.equal(sent.state,'broadcast');record(phase,await chain.included(r.signed.requestId));return call('non-evm/injective/reconcile',{id:r.id});};
 let count=0;const check=(name,fn)=>t.test(name,async()=>{await fn();count++;});
 let source,cancel,withdraw,sub,policy;
 await check('Owner creates and durably records a real 2-unit order',async()=>{
  const request=await orderRequest(chain,0,{side:'sell',quantity:'2',limitPrice:'11',requestKey:'inj06-order'});
  ({maxTradingFeeBps:sub,...policy}=request.policy);sub=chain.actors[0].subaccountId.slice(0,-1)+'1';
  const review=await preflightInjectiveLimitOrder(request),p=await call('non-evm/injective/prepare',{accountId:account.id,review});
  source=await submitIncluded(await approve(p),'owner-create-two');assert.equal(source.state,'reported-confirmed');assert.equal((await orders()).length,1);
 });
 await check('Independent counterparty fills only 0.5; same order retains 1.5',async()=>{
  const review=await preflightInjectiveLimitOrder(await orderRequest(chain,1,{side:'buy',quantity:'0.5',limitPrice:'11',requestKey:'inj06-buyer'}));
  const r=await chain.broadcast(chain.sign(review.transaction,1));assert.equal(r.tx_response.code,0);record('fixture-buy-half',await chain.included(r.tx_response.txhash));assert.equal((await orders())[0].fillable,'1.500000000000000000');
 });
 await check('Cancel preparation binds the persisted order and approval signs without sending',async()=>{
  const order=(await orders())[0],before=await sequence(),p=await call('non-evm/injective/cancel/prepare',{accountId:account.id,sourceRecordId:source.id,payment:{requestKey:'inj06-cancel',orderHash:order.order_hash,policy}});
  assert.equal(p.summary.amountAtomic,'1500000000000000000');assert.equal(p.summary.orderHash,order.order_hash);assert.equal(p.summary.sourceRecordId,source.id);
  cancel=await approve(p);assert.equal(cancel.state,'signed');assert.equal(await sequence(),before);assert.equal((await vault.injectiveRecords()).at(-1).signed.requestId,cancel.signed.requestId);
 });
 await check('Owner one-send cancellation removes only remainder and preserves bought base',async()=>{
  const r=await submitIncluded(cancel,'owner-cancel-remainder');assert.equal(r.report.actionEffect.orderPresent,false);assert.equal(r.report.finalityProven,false);
  assert.deepEqual(await orders(),[]);assert.equal(BigInt(await balance('ubase')),initialBase-500000000000000000n);
  await assert.rejects(submit(cancel),/RESUBMISSION/);
 });
 await check('Deposit setup funds nondefault exchange balance, not the gas bank twice',async()=>{
  const tx=await localTransaction(chain,0,movement(chain,0,'Deposit',sub,'1000000000000000000')),r=await chain.broadcast(chain.sign(tx,0));assert.equal(r.tx_response.code,0);record('fixture-deposit-one',await chain.included(r.tx_response.txhash));
  assert.equal(BigInt(await balance('ubase')),initialBase-1500000000000000000n);
 });
 const body=amount=>({accountId:account.id,payment:{requestKey:'inj06-withdraw',endpoint:chain.rest,subaccountId:sub,denom:'ubase',amountAtomic:amount,policy}});
 await check('One-atom excess withdrawal fails before signing/fee/sequence changes',async()=>{
  const before=await sequence(),n=(await vault.injectiveRecords()).length;
  await assert.rejects(call('non-evm/injective/withdraw/prepare',body('1000000000000000001')),/INSUFFICIENT/);
  assert.equal(await sequence(),before);assert.equal((await vault.injectiveRecords()).length,n);
 });
 await check('Owner review fixes self destination and exact available amount',async()=>{
  const before=await sequence(),p=await call('non-evm/injective/withdraw/prepare',body('1000000000000000000'));
  assert.equal(p.summary.recipient,chain.actors[0].address);assert.equal(p.summary.review.state.availableAtomic,'1000000000000000000');
  withdraw=await approve(p);assert.equal(withdraw.state,'signed');assert.equal(await sequence(),before);
 });
 let sends=0;
 await check('Real withdrawal is transmitted once despite deliberate response loss',async()=>{
  const actual=app.nonEvm.injectiveEngine.fetchImpl;
  app.nonEvm.injectiveEngine.fetchImpl=async(url,opts)=>{if(opts.method==='POST'&&url.endsWith('/cosmos/tx/v1beta1/txs')){sends++;const r=await actual(url,opts);await r.arrayBuffer();throw Error('INTENTIONAL_RESPONSE_LOSS');}return actual(url,opts);};
  const r=await submit(withdraw);assert.equal(r.state,'broadcast-unknown');assert.equal(sends,1);
  record('owner-withdraw-lost-response',await chain.included(withdraw.signed.requestId));
  await assert.rejects(submit(withdraw),/RESUBMISSION/);assert.equal(sends,1);
 });
 let restarted;
 await check('Fresh process restores Vault, rejects resend, and reads only stored hash',async()=>{
  await app.close();app=null;const before=await sequence();
  const code=`import {PrivateStore} from ${JSON.stringify(new URL('../../wallet/lib/storage.mjs',import.meta.url).href)};
import {Vault} from ${JSON.stringify(new URL('../../wallet/lib/vault.mjs',import.meta.url).href)};
import {InjectiveOwnerEngine} from ${JSON.stringify(new URL('../../wallet/injective/engine.mjs',import.meta.url).href)};
const v=new Vault(new PrivateStore(process.argv[1]));await v.unlock(${JSON.stringify(PASSWORD)});
const engine=new InjectiveOwnerEngine(),r=(await v.injectiveRecords()).find(x=>x.id===process.argv[2]);
let retry;try{await engine.broadcast(v,r);}catch(e){retry=e.message;}
const final=await engine.reconcile(v,r);console.log(JSON.stringify({retry,state:final.state,hash:final.signed.requestId,report:final.report}));await v.lock();`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code,directory,withdraw.id],{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr);restarted=JSON.parse(r.stdout);assert.equal(restarted.retry,'INJECTIVE_RESUBMISSION_FORBIDDEN');assert.equal(restarted.state,'reported-confirmed');assert.equal(restarted.hash,withdraw.signed.requestId);assert.equal(await sequence(),before);
 });
 await check('Post-inclusion bank/deposit observations and exact real balances agree',async()=>{
  const e=restarted.report.actionEffect;assert.equal(e.status,'observed');assert.equal(e.independentProof,false);
  assert.equal(e.availableAtomic,'0');assert.equal(e.totalAtomic,'0');assert.equal(e.bankBalanceAtomic,String(initialBase-500000000000000000n));
  assert.equal(await balance('ubase'),e.bankBalanceAtomic);assert.equal(BigInt(initialGas)-BigInt(await balance('inj')),4n*500000000000000n);
 });
 assert.equal(count,10);
 if(process.env.REALDEX_INJ06_EVIDENCE){const git=x=>execFileSync('git',['rev-parse',x],{encoding:'utf8'}).trim();
  fs.writeFileSync(process.env.REALDEX_INJ06_EVIDENCE,JSON.stringify({schema:'realdex.inj06-real-owner-actions.v1',passed:true,subchecks:count,commit:git('HEAD'),tree:git('HEAD^{tree}'),version:chain.version,publicNetwork:false,productionReady:false,transactions,withdrawSends:sends,restarted,finalBase:await balance('ubase'),finalGas:await balance('inj')},null,2)+'\n',{flag:'wx',mode:0o600});}
});
