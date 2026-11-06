/** Owner API tests use synthetic loopback REST; the real exchange is tested separately. */
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {chainFixture,walletFixture,withdrawBody,approve} from './injective-actions-fixture.mjs';
import {validateInjectiveReview,verifyInjectiveSigned} from '../injective/codec.mjs';
import {validateInjectiveRecord} from '../injective/records.mjs';
import {PrivateStore} from '../lib/storage.mjs';import {Vault} from '../lib/vault.mjs';import {InjectiveOwnerEngine} from '../injective/engine.mjs';
import {PASSWORD} from './fixtures.mjs';
const route='non-evm/injective/deposit/prepare';
const body=(w,c,extra={})=>withdrawBody(w,c,{requestKey:'deposit-one',...extra});
const submit=(w,r)=>w.call('non-evm/injective/submit',{id:r.id,confirmation:r.signed.requestId});
const rehash=r=>{const {reviewSha256,...b}=r;return {...b,reviewSha256:createHash('sha256').update(JSON.stringify(b)).digest('hex')};};
const safe=r=>{for(const k of ['ownerApproved','chainStateAuthenticated','signingEnabled','broadcastEnabled','executable','settlementVerified'])assert.equal(r[k],false,k);};
async function setup(t,extra={}){const c=await chainFixture(t),w=await walletFixture(t,c);return {c,w,request:body(w,c,extra)};}

test('Self deposit: exact reviewed destination, durable signature, single send, typed post-state',async t=>{
 const {c,w,request}=await setup(t),p=await w.call(route,request);safe(p.summary.review);
 assert.equal(p.summary.action,'deposit');assert.equal(p.summary.side,'deposit');assert.equal(p.summary.operation,'injective-deposit-local');
 assert.equal(p.summary.recipient,request.payment.subaccountId);assert.equal(p.summary.destination,request.payment.subaccountId);
 assert.equal((await w.vault.injectiveRecords()).length,0);assert.equal(c.state.sent,0);
 const oracle=spawnSync('python3',[new URL('./injective-actions-reference.py',import.meta.url).pathname],{input:JSON.stringify(p.summary.review),encoding:'utf8',timeout:10000});
 assert.equal(oracle.status,0,oracle.stderr);assert.equal(JSON.parse(oracle.stdout).kind,'deposit');
 const r=await approve(w,p);assert.equal(r.state,'signed');verifyInjectiveSigned(r.signed,r.summary,w.vault.account(w.account.id));assert.equal(c.state.sent,0);
 const duplicate=await w.call(route,request);assert.equal(duplicate.record.id,r.id);assert.equal(duplicate.submittedAgain,false);
 assert.equal((await submit(w,r)).state,'broadcast');assert.equal(c.state.sent,1);
 const final=await w.call('non-evm/injective/reconcile',{id:r.id});assert.equal(final.state,'reported-confirmed');assert.equal(final.report.actionEffect.kind,'deposit');assert.equal(final.report.actionEffect.independentProof,false);
 await assert.rejects(submit(w,r),/RESUBMISSION/);assert.equal(c.state.sent,1);
});
for(const [name,patch] of [
 ['zero',{amountAtomic:'0'}],['fraction',{amountAtomic:'0.5'}],['number',{amountAtomic:1}],['negative',{amountAtomic:'-1'}],['leading zero',{amountAtomic:'01'}],['exponent',{amountAtomic:'1e18'}],['oversized',{amountAtomic:'9'.repeat(79)}],
 ['foreign destination',{destination:'inj1other'}],['foreign sender',{sender:'inj1other'}],['foreign subaccount',{subaccountId:'0x'+'ab'.repeat(32)}],['default subaccount',null],
 ['denom injection',{denom:'inj?x=y'}],['public endpoint',{endpoint:'https://example.invalid'}],['endpoint credentials',{endpoint:'http://user:secret@127.0.0.1:1000'}]
])test('Deposit rejects '+name+' before node requests',async t=>{
 const {c,w}=await setup(t);const n=c.state.calls.length;
 await assert.rejects(w.call(route,body(w,c,patch??{subaccountId:c.input.subaccountId})));assert.equal(c.state.calls.length,n);assert.equal(c.state.sent,0);
});
test('Owner API requires valid token AND same-origin; no agent/dapp deposit authority',async t=>{
 const {c,w,request}=await setup(t);for(const [auth,origin] of [[undefined,w.started.origin],['Bearer '+w.app.uiToken,'http://other.invalid']]){
 const r=await fetch(w.started.origin+'/api/'+route,{method:'POST',headers:{origin,'content-type':'application/json',...(auth?{authorization:auth}:{})},body:JSON.stringify(request)});assert.equal(r.ok,false);
 }assert.equal(c.state.calls.length,0);
});
for(const [denom,bank,gas,amount,accept] of [
 ['udemo','500000000000000000','1000000000000000','500000000000000000',true],
 ['udemo','499999999999999999','1000000000000000','500000000000000000',false],
 ['udemo','999999999999999999','499999999999999','1',false],
 ['inj','0','1000000000000000','500000000000000',true],
 ['inj','999999999999999999','999999999999999','500000000000000',false],
 ['inj','0','500000000000000','1',false]
])test('Exact deposit/gas boundary '+[denom,bank,gas,amount,accept].join('/'),async t=>{
 const {c,w}=await setup(t);c.state.bank=bank;c.state.gas=gas;c.state.available='0';c.state.total='0';const request=body(w,c,{denom,amountAtomic:amount});
 if(accept){const p=await w.call(route,request);safe(p.summary.review);assert.equal(p.summary.review.state.bankBalanceAtomic,denom==='inj'?gas:bank);}
 else await assert.rejects(w.call(route,request),/INSUFFICIENT/);
 assert.equal(c.state.sent,0);assert.equal((await w.vault.injectiveRecords()).length,0);
 if(denom==='inj')assert.equal(c.state.calls.filter(x=>x.route.includes('/spendable_balances/')).length,1);
});
test('Existing exchange funds cannot fund a bank deposit',async t=>{
 const {c,w,request}=await setup(t);c.state.bank='1';c.state.available=c.state.total='1000000000000000000000000000000';
 await assert.rejects(w.call(route,request),/DEPOSIT_INSUFFICIENT/);assert.equal(c.state.sent,0);
});
for(const phase of ['approval','submit'])test('Fresh funds rechecked before '+phase,async t=>{
 const {c,w,request}=await setup(t),p=await w.call(route,request);let r;if(phase==='submit')r=await approve(w,p);c.state.bank='1';
 await assert.rejects(phase==='submit'?submit(w,r):approve(w,p),/INSUFFICIENT/);assert.equal(c.state.sent,0);assert.equal((await w.vault.injectiveRecords()).length,phase==='submit'?1:0);
});
for(const phase of ['approval','submit'])test('Deposit '+phase+' persistence failure performs zero sends and locks Vault',async t=>{
 const {c,w,request}=await setup(t),p=await w.call(route,request);let r;if(phase==='submit')r=await approve(w,p);let n=0;
 w.f.store.write=()=>{n++;throw Error('TEST_SAVE_FAILURE');};await assert.rejects(phase==='submit'?submit(w,r):approve(w,p));
 assert.equal(n,1);assert.equal(w.vault.status().locked,true);assert.equal(c.state.sent,0);
});
test('Owner cannot combine deposit sign and send or approve wrong review digest',async t=>{
 const {c,w,request}=await setup(t),p=await w.call(route,request);
 await assert.rejects(w.call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256,broadcast:true}),/STORES_BEFORE_SUBMIT/);
 const q=await w.call(route,request);await assert.rejects(w.call('non-evm/approve',{id:q.id,intentId:q.intentId,confirmation:'a'.repeat(64),broadcast:false}),/CONFIRMATION/);assert.equal(c.state.sent,0);
});
test('Deposit cannot be switched to withdrawal, foreign destination or hidden amount by rehashing',async t=>{
 const {c,w}=await setup(t),p=await w.call(route,body(w,c,{denom:'inj',amountAtomic:'1'}));
 for(const change of [r=>r.action.kind='withdraw',r=>r.action.destination=r.action.sender,r=>r.action.subaccountId=r.action.subaccountId.slice(0,-1)+'2',r=>r.action.amountAtomic='2',r=>r.transaction.fee.amount='0',r=>r.transaction.bodyBytesBase64='AA==',r=>r.state.bankBalanceAtomic='999999999999999999999999',r=>r.ownerApproved=true]){
 const altered=structuredClone(p.summary.review);change(altered);assert.throws(()=>validateInjectiveReview(rehash(altered),w.vault.account(w.account.id),{now:w.clock.value}));
 }assert.equal(c.state.sent,0);
});
test('Deposit journal summary must identify the signed deposit and destination exactly',async t=>{
 const {c,w,request}=await setup(t),r=await approve(w,await w.call(route,request));
 for(const [key,value] of [['action','withdraw'],['operation','injective-withdraw-local'],['recipient','inj1other'],['destination','inj1other'],['side','withdraw'],['amountAtomic','1']]){
 const modified=structuredClone(r);modified.summary[key]=value;assert.throws(()=>validateInjectiveRecord(modified,[w.vault.account(w.account.id)]));
 }
});
test('Same request key is idempotent only for the same action, destination, amount and fee',async t=>{
 const {c,w,request}=await setup(t);await approve(w,await w.call(route,request));
 for(const change of [{amountAtomic:'1'},{subaccountId:request.payment.subaccountId.slice(0,-1)+'2'},{denom:'inj'}])await assert.rejects(w.call(route,body(w,c,change)),/CONTENT_CONFLICT/);
 await assert.rejects(w.call('non-evm/injective/withdraw/prepare',request),/CONTENT_CONFLICT/);assert.equal(c.state.sent,0);
});
test('Lost deposit response, reboot and exact-hash reconciliation never resend',async t=>{
 const {c,w,request}=await setup(t),r=await approve(w,await w.call(route,request));c.state.drop=true;
 assert.equal((await submit(w,r)).state,'broadcast-unknown');assert.equal(c.state.sent,1);await w.shutdown();
 const store=new PrivateStore(w.f.directory),v=new Vault(store,{now:()=>w.clock.value});await v.unlock(PASSWORD);
 try{const engine=new InjectiveOwnerEngine({now:()=>w.clock.value}),prior=(await v.injectiveRecords())[0];
 await assert.rejects(engine.broadcast(v,prior),/RESUBMISSION/);const final=await engine.reconcile(v,prior);assert.equal(final.state,'reported-confirmed');assert.equal(final.report.actionEffect.kind,'deposit');assert.equal(c.state.sent,1);
 }finally{await v.lock();store.close();}
});
test('Unknown deposit blocks replacement and cannot retire from not-found before signed timeout',async t=>{
 const {c,w,request}=await setup(t),r=await approve(w,await w.call(route,request));c.state.drop=true;await submit(w,r);c.state.txs.clear();
 const status=await w.call('non-evm/injective/reconcile',{id:r.id});assert.equal(status.state,'broadcast-unknown');
 await assert.rejects(w.call(route,body(w,c,{requestKey:'new'})),/UNRESOLVED/);
 const before=w.f.store.read(),records=await w.vault.injectiveRecords();
 assert.ok(BigInt(c.state.height)<=BigInt(r.summary.timeoutHeight));
 await assert.rejects(w.call('non-evm/injective/recovery/prepare',{id:r.id}),/^Error: INJECTIVE_RECOVERY_NOT_EXPIRED$/);
 assert.equal(c.state.sent,1);assert.equal(w.f.store.read(),before);assert.deepEqual(await w.vault.injectiveRecords(),records);
 assert.equal(records[0].state,'broadcast-unknown');assert.equal(records[0].retirement,undefined);
});
test('Post-inclusion deposit-state failure remains separate from successful transaction inclusion',async t=>{
 const {c,w,request}=await setup(t),r=await approve(w,await w.call(route,request));await submit(w,r);c.state.mutate=(o,url)=>{if(url.includes('/subaccountDeposit'))delete o.deposits;};
 const final=await w.call('non-evm/injective/reconcile',{id:r.id});assert.equal(final.state,'reported-confirmed');assert.deepEqual(final.report.actionEffect,{kind:'deposit',status:'unavailable',independentProof:false});
});
test('Conflicting height or missing deposit state fails preparation, not assumed zero',async t=>{
 const {c,w,request}=await setup(t);for(const mode of ['height','state']){c.state.mutate=(o,url,headers)=>{if(url.includes('/subaccountDeposit')){if(mode==='height')headers['x-cosmos-block-height']='999';else delete o.deposits;}};await assert.rejects(w.call(route,request),/HEIGHT|DEPOSIT_MISSING/);}assert.equal(c.state.sent,0);
});
test('Competing deposit submit requests issue only one network send',async t=>{
 const {c,w,request}=await setup(t),r=await approve(w,await w.call(route,request));const result=await Promise.allSettled([submit(w,r),submit(w,r)]);
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(c.state.sent,1);
});
