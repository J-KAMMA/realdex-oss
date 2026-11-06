import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chainFixture,walletFixture,actionPolicy,createSource,cancelBody,withdrawBody,approve} from './injective-actions-fixture.mjs';
import {validateInjectiveReview,injectiveReviewFromSummary,verifyInjectiveSigned} from '../injective/codec.mjs';
import {ACTION_OPERATIONS} from '../injective/action-codec.mjs';
import {PrivateStore} from '../lib/storage.mjs';import {Vault} from '../lib/vault.mjs';import {WalletServer} from '../lib/server.mjs';
import {PASSWORD} from './fixtures.mjs';

const cancelRoute='non-evm/injective/cancel/prepare',withdrawRoute='non-evm/injective/withdraw/prepare';
const submit=(w,r)=>w.call('non-evm/injective/submit',{id:r.id,confirmation:r.signed.requestId});
const rehash=r=>{const {reviewSha256,...b}=r;return {...b,reviewSha256:createHash('sha256').update(JSON.stringify(b)).digest('hex')};};
const falseAuthority=r=>{for(const k of ['ownerApproved','chainStateAuthenticated','signingEnabled','broadcastEnabled','executable','settlementVerified'])assert.equal(r[k],false,k);};

for(const kind of ['cancel','withdraw'])test(kind+': prepare/sign/store/one-send/reconcile stays owner-bound',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),source=kind==='cancel'?await createSource(w,c):null;
 const request=kind==='cancel'?cancelBody(w,c,source):withdrawBody(w,c),n=c.state.sent;
 const prepared=await w.call(kind==='cancel'?cancelRoute:withdrawRoute,request);
 assert.equal(c.state.sent,n);assert.equal(prepared.summary.action,kind);falseAuthority(prepared.summary.review);
 const r=await approve(w,prepared);assert.equal(c.state.sent,n);assert.equal(r.state,'signed');assert.equal(r.summary.operation,ACTION_OPERATIONS[kind]);verifyInjectiveSigned(r.signed,r.summary,w.vault.account(w.account.id));
 const repeat=await w.call(kind==='cancel'?cancelRoute:withdrawRoute,request);assert.equal(repeat.alreadyRecorded,true);assert.equal(repeat.record.id,r.id);
 const sent=await submit(w,r);assert.equal(sent.state,'broadcast');assert.equal(c.state.sent,n+1);
 const final=await w.call('non-evm/injective/reconcile',{id:r.id});assert.equal(final.state,'reported-confirmed');assert.equal(final.report.actionEffect.kind,kind);assert.equal(final.report.actionEffect.independentProof,false);
 if(kind==='cancel')assert.equal(final.report.actionEffect.orderPresent,false);
 assert.deepEqual(await w.call('non-evm/injective/reconcile',{id:r.id}),final);
 await assert.rejects(submit(w,r),/RESUBMISSION/);assert.equal(c.state.sent,n+1);
 const oracle=spawnSync('python3',[new URL('./injective-actions-reference.py',import.meta.url).pathname],{input:JSON.stringify(prepared.summary.review),encoding:'utf8',timeout:10000});
 assert.equal(oracle.status,0,oracle.stderr);assert.equal(JSON.parse(oracle.stdout).passed,true);
});

test('Actions cannot bypass owner API token or origin',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c);
 for(const origin of [w.started.origin,'http://hostile.invalid']){const r=await fetch(w.started.origin+'/api/'+withdrawRoute,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(withdrawBody(w,c))});assert.equal(r.ok,false);}
 assert.equal(c.state.sent,0);
});

test('Cancel pending requires its exact persisted confirmed source, not a supplied plan',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c);
 await assert.rejects(w.call(cancelRoute,cancelBody(w,c,{id:'missing'})),/CANCEL_SOURCE/);
 const src=await createSource(w,c);
 await assert.rejects(w.call(cancelRoute,{...cancelBody(w,c,src),review:{}}),/SCHEMA/);
 assert.equal(c.state.sent,1);
});

test('Wrong cancel order hash/CID/side/price/original quantity are rejected',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),src=await createSource(w,c),original=structuredClone(c.state.orders);
 for(const [key,value]of [['order_hash','0x'+'ff'.repeat(32)],['cid','rdx-'+'f'.repeat(32)],['isBuy',false],['price','12'],['quantity','1.26'],['fillable','1.250000000000000001']]){
  c.state.orders=structuredClone(original);c.state.orders[0][key]=value;
  await assert.rejects(w.call(cancelRoute,cancelBody(w,c,src)),/CANCEL|PRECISION/);
 }assert.equal(c.state.sent,1);
});

for(const [name,patch]of [
 ['zero amount',{amountAtomic:'0'}],['float amount',{amountAtomic:'0.5'}],['exponent',{amountAtomic:'1e18'}],['leading zero',{amountAtomic:'01'}],
 ['negative amount',{amountAtomic:'-1'}],['numeric amount',{amountAtomic:1}],['oversized amount',{amountAtomic:'9'.repeat(79)}],
 ['foreign destination',{destination:'inj1other'}],['foreign subaccount',{subaccountId:'0x'+'00'.repeat(32)}],
 ['default subaccount',null],['path injection',{denom:'ubase?denom=inj'}],['unbounded denom',{denom:'a'.repeat(129)}],
 ['public endpoint',{endpoint:'https://api.example.invalid'}],['credentials in endpoint',{endpoint:'http://user:pass@127.0.0.1:1234'}]
])test('Withdraw invalid '+name+' rejects before node I/O',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),req=withdrawBody(w,c,patch??{subaccountId:c.input.subaccountId});
 const calls=c.state.calls.length;await assert.rejects(w.call(withdrawRoute,req));assert.equal(c.state.calls.length,calls);assert.equal(c.state.sent,0);
});

test('Withdrawal uses available, not total; locked funds and fractional atoms cannot be spent',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c);c.state.available='499999999999999999.999999999999999999';
 await assert.rejects(w.call(withdrawRoute,withdrawBody(w,c)),/INSUFFICIENT/);assert.equal(c.state.sent,0);
});
test('Available exactly equals withdrawal amount; fee is still funded from bank INJ',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c);c.state.available='500000000000000000';c.state.gas='500000000000000';
 const p=await w.call(withdrawRoute,withdrawBody(w,c));assert.equal(p.summary.review.gasBalanceAtomic,c.state.gas);
});
test('Insufficient bank gas is never financed from the intended INJ withdrawal',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c);c.state.gas='499999999999999';
 await assert.rejects(w.call(withdrawRoute,withdrawBody(w,c,{denom:'inj'})),/INSUFFICIENT_GAS/);assert.equal(c.state.sent,0);
});
test('Prepared withdrawal becomes unaffordable before signing: no signature or send',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c));c.state.available='0';
 await assert.rejects(approve(w,p),/INSUFFICIENT/);assert.equal((await w.vault.injectiveRecords()).length,0);assert.equal(c.state.sent,0);
});
test('Prepared cancellation tolerates more partial fills, never a growing remainder',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),src=await createSource(w,c),p=await w.call(cancelRoute,cancelBody(w,c,src));
 c.state.orders[0].fillable='0.5';const r=await approve(w,p);c.state.orders[0].fillable='1.1';
 await assert.rejects(submit(w,r),/REMAINDER_GREW/);assert.equal(c.state.sent,1);
});
test('A fully filled/cancelled order before submission is not blindly sent',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),src=await createSource(w,c),p=await w.call(cancelRoute,cancelBody(w,c,src)),r=await approve(w,p);c.state.orders=[];
 await assert.rejects(submit(w,r),/ORDER_NOT_OPEN/);assert.equal(c.state.sent,1);assert.equal((await w.vault.injectiveRecords()).at(-1).state,'signed');
});
test('Missing/conflicting height and changed block identity stop action preparation',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c);
 for(const change of ['missing','conflict','reorg']){
  c.state.mutate=(o,route,h)=>{if(change==='missing')delete h['grpc-metadata-x-cosmos-block-height'];if(change==='conflict')h['x-cosmos-block-height']='999';if(change==='reorg'&&route.endsWith('/blocks/100'))o.block_id.hash='22'.repeat(32);};
  await assert.rejects(w.call(withdrawRoute,withdrawBody(w,c)),/HEIGHT|BLOCK_CHANGED/);
 }assert.equal(c.state.sent,0);
});
test('Wrong approval/tx confirmation and sign+send shortcut are rejected',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c));
 await assert.rejects(w.call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256,broadcast:true}),/STORES_BEFORE_SUBMIT/);
 const q=await w.call(withdrawRoute,withdrawBody(w,c)),r=await approve(w,q);
 await assert.rejects(w.call('non-evm/injective/submit',{id:r.id,confirmation:'0'.repeat(64)}),/CONFIRMATION/);assert.equal(c.state.sent,0);
});

for(const phase of ['sign','submit'])test('Injected persistence failure before '+phase+' transmits zero bytes',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c));let r;
 if(phase==='submit')r=await approve(w,p);
 let writes=0;w.f.store.write=()=>{writes++;throw Error('TEST_SAVE_FAILURE');};
 await assert.rejects(phase==='submit'?submit(w,r):approve(w,p));assert.equal(writes,1);assert.equal(c.state.sent,0);assert.equal(w.vault.status().locked,true);
});
for(const kind of ['cancel','withdraw'])test(kind+': lost response persists across new Vault/server; no retry',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),src=kind==='cancel'?await createSource(w,c):null,p=await w.call(kind==='cancel'?cancelRoute:withdrawRoute,kind==='cancel'?cancelBody(w,c,src):withdrawBody(w,c)),r=await approve(w,p),before=c.state.sent;
 c.state.drop=true;const unknown=await submit(w,r);assert.equal(unknown.state,'broadcast-unknown');assert.equal(c.state.sent,before+1);
 await w.shutdown();const store=new PrivateStore(w.f.directory),vault=new Vault(store,{now:()=>w.clock.value});await vault.unlock(PASSWORD);
 const app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]},now:()=>w.clock.value});t.after(()=>app.close());const start=await app.start(0);
 const call=async(route,body)=>{const res=await fetch(start.origin+'/api/'+route,{method:'POST',headers:{origin:start.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json'},body:JSON.stringify(body)}),v=await res.json();if(!res.ok)throw Error(v.error);return v;};
 await assert.rejects(call('non-evm/injective/submit',{id:r.id,confirmation:r.signed.requestId}),/RESUBMISSION/);
 assert.equal((await call('non-evm/injective/reconcile',{id:r.id})).state,'reported-confirmed');assert.equal(c.state.sent,before+1);await app.close();
});
test('Unknown cancel/withdraw blocks all further Injective signing on the same key',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c));await approve(w,p);
 await assert.rejects(w.call(withdrawRoute,withdrawBody(w,c,{requestKey:'second'})),/UNRESOLVED/);
 const review=await c.review('second-order');await assert.rejects(w.call('non-evm/injective/prepare',{accountId:w.account.id,review}),/UNRESOLVED/);assert.equal(c.state.sent,0);
});
test('All action transaction bytes and displays are independently bound, even after rehash',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c)),original=p.summary.review;
 for(const change of [r=>{r.action.destination='inj1other';},r=>{r.action.amountAtomic='1';},r=>{r.account.sequence='99';},r=>{r.transaction.bodyBytesBase64='AA==';},r=>{r.transaction.authInfoBytesBase64='AA==';},r=>{r.transaction.signDocBase64='AA==';},r=>{r.transaction.simulationTxBase64='AA==';},r=>{r.transaction.fee.amount='1';},r=>{r.transaction.timeoutHeight='999';},r=>{r.ownerApproved=true;}]){
  const r=structuredClone(original);change(r);assert.throws(()=>validateInjectiveReview(rehash(r),w.vault.account(w.account.id),{now:w.clock.value}));
 }
});
test('Balance effect failure is visible separately from the included successful receipt',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c)),r=await approve(w,p);await submit(w,r);
 c.state.mutate=(o,route)=>{if(route.includes('/subaccountDeposit'))delete o.deposits;};
 const final=await w.call('non-evm/injective/reconcile',{id:r.id});assert.equal(final.state,'reported-confirmed');assert.equal(final.report.actionEffect.status,'unavailable');assert.equal(final.report.finalityProven,false);
});

test('Summary target changes cannot misdescribe a signed cancel/withdraw record',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c)),r=await approve(w,p);
 const {validateInjectiveRecord}=await import('../injective/records.mjs');
 for(const [key,value]of [['destination','inj1other'],['amountAtomic','1'],['feeAtomic','0'],['expiresAt',r.summary.expiresAt+1],['sequenceKey','false'],['submissionEnabled',false]]){
  const altered=structuredClone(r);altered.summary[key]=value;assert.throws(()=>validateInjectiveRecord(altered,[w.vault.account(w.account.id)]),/SUMMARY_CHANGED/);
 }
});
test('Post-sign insufficient withdrawal balance leaves signed bytes unsent',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c)),r=await approve(w,p);
 c.state.available='1';await assert.rejects(submit(w,r),/INSUFFICIENT/);assert.equal(c.state.sent,0);
 assert.equal((await w.vault.injectiveRecords()).at(-1).state,'signed');
});
test('Two simultaneous submit API calls transmit only one transaction',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c)),r=await approve(w,p);
 const result=await Promise.allSettled([submit(w,r),submit(w,r)]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(c.state.sent,1);
});
test('Explicit withdraw CheckTx rejection stays terminal and is never resent',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c)),r=await approve(w,p);
 c.state.checkTxCode=5;assert.equal((await submit(w,r)).state,'reported-reverted');await assert.rejects(submit(w,r),/RESUBMISSION/);assert.equal(c.state.sent,1);
});
test('Not-found after ambiguous send keeps uncertainty, never new signing authority',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c)),r=await approve(w,p);
 c.state.drop=true;await submit(w,r);c.state.txs.clear();
 const observed=await w.call('non-evm/injective/reconcile',{id:r.id});assert.equal(observed.state,'broadcast-unknown');assert.equal(observed.report.reason,'NOT_FOUND_DOES_NOT_PROVE_FAILURE');
 await assert.rejects(submit(w,r),/RESUBMISSION/);assert.equal(c.state.sent,1);
});
test('Owner-engine fetch that ignores abort still has a finite deadline',async()=>{
 const {InjectiveOwnerEngine}=await import('../injective/engine.mjs');
 const engine=new InjectiveOwnerEngine({timeoutMs:100,fetchImpl:()=>new Promise(()=>{})}),keep=setTimeout(()=>{},500);
 try{await assert.rejects(engine.request({endpoint:'http://127.0.0.1:1'},'/cosmos/base/tendermint/v1beta1/blocks/latest'),/TRANSPORT_UNCERTAIN/);}finally{clearTimeout(keep);}
});
test('Engine rejects custom-fetch redirect and arbitrary write paths',async()=>{
 const {InjectiveOwnerEngine}=await import('../injective/engine.mjs');
 const engine=new InjectiveOwnerEngine({fetchImpl:async()=>({redirected:true})}),review={endpoint:'http://127.0.0.1:1'};
 await assert.rejects(engine.request(review,'/unsafe',{body:{}}),/WRITE_PATH/);
 await assert.rejects(engine.request(review,'/cosmos/base/tendermint/v1beta1/blocks/latest'),/REDIRECT/);
});

test('Expiry reached during final recheck cannot transmit signed action bytes',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c)),r=await approve(w,p);
 const engine=w.app.nonEvm.injectiveEngine,recheck=engine.recheck.bind(engine);
 engine.recheck=async(...a)=>{const result=await recheck(...a);w.clock.value=r.summary.expiresAt;return result;};
 await assert.rejects(submit(w,r),/REVIEW_EXPIRED/);assert.equal(c.state.sent,0);assert.equal((await w.vault.injectiveRecords()).at(-1).state,'signed');
});
test('Expiry during durable starting-state save conservatively retains unknown without a send',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c)),r=await approve(w,p),save=w.f.store.write.bind(w.f.store);
 w.f.store.write=(...a)=>{const result=save(...a);w.clock.value=r.summary.expiresAt;return result;};
 await assert.rejects(submit(w,r),/REVIEW_EXPIRED/);assert.equal(c.state.sent,0);assert.equal((await w.vault.injectiveRecords()).at(-1).state,'broadcast-unknown');
});

test('Rejected malformed observation leaves both in-memory and stored journal unchanged',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await w.call(withdrawRoute,withdrawBody(w,c)),r=await approve(w,p);
 let writes=0;const write=w.f.store.write.bind(w.f.store);w.f.store.write=(...args)=>{writes++;return write(...args);};
 const original=await w.vault.injectiveRecords(),report={observedAt:w.clock.value,received:true,reason:'INCLUDED_SUCCESS',transactionHash:r.signed.requestId,automaticRetry:false,finalityProven:false,height:'101',code:0};
 for(const patch of [{height:'0'},{transactionHash:'A'.repeat(64)},{code:1},{actionEffect:{kind:'cancel',status:'unavailable',independentProof:false}},{automaticRetry:true}]){
  await assert.rejects(w.vault.observeInjective(r,'reported-confirmed',{...report,...patch}));
  assert.deepEqual(await w.vault.injectiveRecords(),original);
 }
 assert.equal(writes,0);assert.equal(c.state.sent,0);
 await w.shutdown();const store=new PrivateStore(w.f.directory);const restored=new Vault(store,{now:()=>w.clock.value});await restored.unlock(PASSWORD);assert.deepEqual(await restored.injectiveRecords(),original);await restored.lock();
});
