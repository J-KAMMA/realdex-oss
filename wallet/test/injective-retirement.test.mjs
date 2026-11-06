import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
import {PrivateStore} from '../lib/storage.mjs';import {Vault} from '../lib/vault.mjs';import {PASSWORD} from './fixtures.mjs';
import {chainFixture,walletFixture,withdrawBody,cancelBody,createSource,approve,NOW,BLOCK} from './injective-actions-fixture.mjs';
import {RETIREMENT_SCHEMA,RETIRED,validateRetirement,validateRetirementReview,signedRecoveryBoundary,assertInjectiveSequenceAvailable} from '../injective/retirement.mjs';
import {validateInjectiveJournal,validateInjectiveRecord} from '../injective/records.mjs';
import {canonical,clone} from '../lib/guard.mjs';
import {injectiveReviewFromSummary,makeInjectiveIntent} from '../injective/codec.mjs';
const PREP='non-evm/injective/recovery/prepare',RETIRE='non-evm/injective/recovery/retire';
const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
async function setup(t){const chain=await chainFixture(t),w=await walletFixture(t,chain);const p=await w.call('non-evm/injective/withdraw/prepare',withdrawBody(w,chain));const r=await approve(w,p);return {chain,w,r};}
function expire(f){f.chain.state.height=Number(f.r.summary.timeoutHeight)+1;}
async function prep(f){expire(f);return f.w.call(PREP,{id:f.r.id});}
function commit(f,p,extra={}){return f.w.call(RETIRE,{id:f.r.id,review:p,confirmation:p.reviewSha256,transactionHash:f.r.signed.requestId,...extra});}
const record=async f=>(await f.w.vault.injectiveRecords()).find(r=>r.id===f.r.id);
const sends=f=>f.chain.state.calls.filter(c=>c.method==='POST'&&c.route==='/cosmos/tx/v1beta1/txs').length;

test('Retirement inspection is read-only; explicit owner retirement preserves complete signed history',async t=>{
 const f=await setup(t),original=await record(f),file=f.w.f.store.read();let writes=0;const write=f.w.f.store.write.bind(f.w.f.store);f.w.f.store.write=(...a)=>{writes++;return write(...a);};
 const p=await prep(f);assert.equal(writes,0);assert.equal(f.w.f.store.read(),file);assert.deepEqual(await record(f),original);
 assert.equal(p.chainStateAuthenticated,false);assert.equal(p.settlementVerified,false);assert.equal(p.automaticRetryAllowed,false);assert.equal(p.evidence.sequence,'0');
 const retired=await commit(f,p);assert.equal(retired.state,RETIRED);assert.equal(writes,1);assert.equal(sends(f),0);
 assert.deepEqual(retired.signed,original.signed);assert.deepEqual(retired.summary,original.summary);assert.equal(retired.id,original.id);validateRetirement(retired);validateInjectiveJournal(f.w.vault.data);
 const reads=f.chain.state.calls.length;assert.equal((await f.w.call('non-evm/injective/reconcile',{id:f.r.id})).state,RETIRED);assert.equal(f.chain.state.calls.length,reads);
 await assert.rejects(f.w.call('non-evm/injective/submit',{id:retired.id,confirmation:retired.signed.requestId}),/RESUBMISSION/);assert.equal(sends(f),0);
});
test('Expired review time alone and exact timeout height cannot release a sequence',async t=>{
 const f=await setup(t);f.w.clock.value=f.r.summary.expiresAt+1;for(const h of [100,Number(f.r.summary.timeoutHeight)]){f.chain.state.height=h;await assert.rejects(f.w.call(PREP,{id:f.r.id}),/NOT_EXPIRED/);}
 assert.equal((await record(f)).state,'signed');assert.equal(sends(f),0);
});
test('Before signed timeout, submitted records cannot retire; invalid/included reports remain ineligible',async t=>{
 for(const state of ['broadcast-unknown','broadcast','reported-reverted','reported-confirmed']){await t.test(state,async t=>{
 const f=await setup(t),base={observedAt:NOW,received:false,reason:'SUBMISSION_STARTING',transactionHash:f.r.signed.requestId,automaticRetry:false,finalityProven:false};
 let r=await f.w.vault.observeInjective(f.r,'broadcast-unknown',base);
 if(state!=='broadcast-unknown')r=await f.w.vault.observeInjective(r,state,{...base,...(state==='reported-confirmed'?{received:true,code:0,height:'101'}:state==='reported-reverted'?{code:5}:{})});
 const n=f.chain.state.calls.length;await assert.rejects(f.w.call(PREP,{id:r.id}),state==='broadcast'||state==='broadcast-unknown'?/NOT_EXPIRED/:/UNSENT_ONLY/);if(!['broadcast','broadcast-unknown'].includes(state))assert.equal(f.chain.state.calls.length,n);assert.equal(sends(f),0);
 });}
});
test('Order disappearing before timeout does not authorize retirement of its cancellation',async t=>{
 const chain=await chainFixture(t),w=await walletFixture(t,chain),source=await createSource(w,chain),r=await approve(w,await w.call('non-evm/injective/cancel/prepare',cancelBody(w,chain,source)));
 chain.state.orders=[];await assert.rejects(w.call('non-evm/injective/submit',{id:r.id,confirmation:r.signed.requestId}),/NOT_OPEN/);
 await assert.rejects(w.call(PREP,{id:r.id}),/NOT_EXPIRED/);assert.equal((await w.vault.injectiveRecords()).at(-1).state,'signed');
});
test('New independently approved operation may reuse the sequence only after preserved expiry barrier',async t=>{
 const f=await setup(t),p=await prep(f);await commit(f,p);
 const pending=await f.w.call('non-evm/injective/withdraw/prepare',withdrawBody(f.w,f.chain,{requestKey:'fresh-after-expiry'}));
 const next=await approve(f.w,pending);assert.equal(next.summary.sequenceKey,f.r.summary.sequenceKey);assert.notEqual(next.signed.requestId,f.r.signed.requestId);
 assert.equal((await f.w.vault.injectiveRecords()).length,2);validateInjectiveJournal(f.w.vault.data);
 await assert.rejects(f.w.call('non-evm/injective/prepare',{accountId:f.w.account.id,review:await f.chain.review('third')}),/UNRESOLVED/);
 const r=await f.w.call('non-evm/injective/submit',{id:next.id,confirmation:next.signed.requestId});assert.equal(r.state,'broadcast');assert.equal(sends(f),1);
});
test('Reusing an old request key never silently signs a replacement',async t=>{
 const f=await setup(t);await commit(f,await prep(f));const result=await f.w.call('non-evm/injective/withdraw/prepare',withdrawBody(f.w,f.chain));assert.equal(result.alreadyRecorded,true);assert.equal(result.record.state,RETIRED);assert.equal((await f.w.vault.injectiveRecords()).length,1);assert.equal(sends(f),0);
});
for(const which of ['confirmation','transactionHash'])test('Wrong '+which+' fails before any recovery HTTP or save',async t=>{
 const f=await setup(t),p=await prep(f),n=f.chain.state.calls.length,raw=f.w.f.store.read();await assert.rejects(commit(f,p,{[which]:'f'.repeat(64)}),/CONFIRMATION/);assert.equal(f.chain.state.calls.length,n);assert.equal(f.w.f.store.read(),raw);
});
for(const which of ['sequence','accountNumber','address','key','type'])test('Chain account '+which+' change rejects retirement',async t=>{
 const f=await setup(t);expire(f);f.chain.state.mutate=d=>{if(d.account){const a=d.account.base_account;if(which==='sequence')a.sequence='1';if(which==='accountNumber')a.account_number='8';if(which==='address')a.address='inj1wrong';if(which==='key')a.pub_key={key:'AAA='};if(which==='type')d.account['@type']='other';}};
 await assert.rejects(f.w.call(PREP,{id:f.r.id}),/ACCOUNT_CHANGED/);assert.equal((await record(f)).state,'signed');
});
for(const which of ['network','hash','time','header-height','missing-header','conflicting-header','pinned-hash','pinned-height','stale-time','future-time'])test('Recovery rejects '+which,async t=>{
 const f=await setup(t);expire(f);f.chain.state.mutate=(d,path,h)=>{
  if(which==='header-height'&&d.account)h['grpc-metadata-x-cosmos-block-height']='1';if(which==='missing-header'&&d.account)delete h['grpc-metadata-x-cosmos-block-height'];if(which==='conflicting-header'&&d.account)h['x-cosmos-block-height']='1';
  if(d.block){if(which==='network')d.block.header.chain_id='injective-1';if(which==='hash')d.block_id.hash='0'.repeat(64);if(which==='time')d.block.header.time='broken';if(which==='stale-time')d.block.header.time=new Date(NOW-30001).toISOString();if(which==='future-time')d.block.header.time=new Date(NOW+2001).toISOString();if(!path.endsWith('latest')){if(which==='pinned-hash')d.block_id.hash='22'.repeat(32);if(which==='pinned-height')d.block.header.height='1';}}
 };await assert.rejects(f.w.call(PREP,{id:f.r.id}));assert.equal((await record(f)).state,'signed');assert.equal(sends(f),0);
});
for(const which of ['first','second','commit'])test('An available transaction receipt at '+which+' lookup requires reconciliation, not retirement',async t=>{
 const f=await setup(t);expire(f);let n=0;const engine=f.w.app.nonEvm.injectiveEngine,request=engine.request.bind(engine);
 engine.request=async(review,path,opts)=>{if(path.endsWith(f.r.signed.requestId)&&++n===(which==='first'?1:which==='second'?2:3))return {tx_response:{txhash:f.r.signed.requestId,height:'100',code:'0'}};return request(review,path,opts);};
 if(which==='commit'){const p=await f.w.call(PREP,{id:f.r.id});await assert.rejects(commit(f,p),/RECEIPT_AVAILABLE/);}else await assert.rejects(f.w.call(PREP,{id:f.r.id}),/RECEIPT_AVAILABLE/);
 assert.equal((await record(f)).state,'signed');
});
test('HTTP or malformed 404 cannot supply a not-found certificate',async t=>{
 const f=await setup(t);expire(f);const engine=f.w.app.nonEvm.injectiveEngine,fetchImpl=engine.fetchImpl;
 for(const [status,body,type] of [[503,'{}','application/json'],[404,'{}','application/json'],[404,'<html>','text/html'],[404,'{"code":5,"code":5,"message":"x"}','application/json'],[404,'{"code":5,"message":"x","details":[1]}','application/json'],[404,'{"code":0,"message":"x"}','application/json']]){
  engine.fetchImpl=(u,o)=>u.endsWith(f.r.signed.requestId)?Promise.resolve(new Response(body,{status,headers:{'content-type':type}})):fetchImpl(u,o);
  await assert.rejects(f.w.call(PREP,{id:f.r.id}));assert.equal((await record(f)).state,'signed');
 }
});
test('Changed record while retirement is being confirmed loses CAS and cannot release it',async t=>{
 const f=await setup(t),p=await prep(f),engine=f.w.app.nonEvm.injectiveEngine,request=engine.request.bind(engine);let once=true;
 engine.request=async(...a)=>{const r=await request(...a);if(once){once=false;await f.w.vault.observeInjective(f.r,'broadcast-unknown',engine.report(f.r.signed.requestId,'SUBMISSION_STARTING'));}return r;};
 await assert.rejects(commit(f,p),/SUPERSEDED/);assert.equal((await record(f)).state,'broadcast-unknown');assert.equal(sends(f),0);
});
test('Owner lock during query prevents any retirement mutation',async t=>{
 const f=await setup(t),p=await prep(f),raw=f.w.f.store.read(),engine=f.w.app.nonEvm.injectiveEngine,request=engine.request.bind(engine);
 engine.request=async(...a)=>{const result=await request(...a);f.w.vault.lock();return result;};await assert.rejects(commit(f,p),/LOCK/);assert.equal(f.w.f.store.read(),raw);assert.equal(sends(f),0);
});
test('Save failure before or after write locks Vault; only recovered disk state is authoritative',async t=>{
 for(const after of [false,true])await t.test(String(after),async t=>{const f=await setup(t),p=await prep(f),write=f.w.f.store.write.bind(f.w.f.store);f.w.f.store.write=(...a)=>{if(after)write(...a);throw Error('TEST_SAVE_FAILURE');};
 await assert.rejects(commit(f,p));assert.equal(f.w.vault.status().locked,true);assert.equal(sends(f),0);f.w.f.store.write=write;
 await f.w.vault.unlock(PASSWORD);assert.equal((await record(f)).state,after?RETIRED:'signed');validateInjectiveJournal(f.w.vault.data);
 });
});
test('Retirement and repeated-sequence journal survive encrypted Vault reopen; old bytes cannot resubmit',async t=>{
 const f=await setup(t);await commit(f,await prep(f));await f.w.vault.lock();await f.w.vault.unlock(PASSWORD);
 assert.equal((await record(f)).state,RETIRED);
 const pending=await f.w.call('non-evm/injective/withdraw/prepare',withdrawBody(f.w,f.chain,{requestKey:'new'}));await approve(f.w,pending);
 const before=await f.w.vault.injectiveRecords();await f.w.vault.lock();await f.w.vault.unlock(PASSWORD);assert.deepEqual(await f.w.vault.injectiveRecords(),before);
 await assert.rejects(f.w.call('non-evm/injective/submit',{id:f.r.id,confirmation:f.r.signed.requestId}),/RESUBMISSION/);assert.equal(sends(f),0);
});
test('Fresh-node height rollback or changed saved block prevents replacement signing',async t=>{
 const f=await setup(t);await commit(f,await prep(f));const retiredHeight=String(f.chain.state.height++);const p=await f.w.call('non-evm/injective/withdraw/prepare',withdrawBody(f.w,f.chain,{requestKey:'new'}));
 f.chain.state.mutate=(d,path)=>{if(d.block&&path.endsWith('/'+retiredHeight)){d.block.header.height=retiredHeight;d.block_id.hash='22'.repeat(32);}};
 await assert.rejects(approve(f.w,p),/ROLLBACK/);assert.equal((await f.w.vault.injectiveRecords()).length,1);assert.equal(sends(f),0);
});
test('Changed saved anchor also prevents broadcasting an already-signed replacement',async t=>{
 const f=await setup(t);await commit(f,await prep(f));const next=await approve(f.w,await f.w.call('non-evm/injective/withdraw/prepare',withdrawBody(f.w,f.chain,{requestKey:'new'})));
 const retiredHeight=String(f.chain.state.height++);f.chain.state.mutate=(d,path)=>{if(d.block&&path.endsWith('/'+retiredHeight)){d.block.header.height=retiredHeight;d.block_id.hash='22'.repeat(32);}};
 await assert.rejects(f.w.call('non-evm/injective/submit',{id:next.id,confirmation:next.signed.requestId}),/ROLLBACK/);assert.equal(sends(f),0);assert.equal((await f.w.vault.injectiveRecords()).at(-1).state,'signed');
});
test('Expired review and rehashed forged retirement fields cannot release signed bytes',async t=>{
 const f=await setup(t),p=await prep(f),initial=await record(f);let writes=0;const write=f.w.f.store.write.bind(f.w.f.store);f.w.f.store.write=(...a)=>{writes++;return write(...a);};
 for(const modify of [q=>{q.recordSha256='f'.repeat(64);},q=>{q.boundary.timeoutHeight='1';},q=>{q.evidence.height='140';},q=>{q.evidence.sequence='1';},q=>{q.neverSubmittedByWallet=false;},q=>{q.chainStateAuthenticated=true;},q=>{q.settlementVerified=true;},q=>{q.automaticRetryAllowed=true;},q=>{q.accountId='other';},q=>{q.expiresAt+=1;}]){
  const q=clone(p);modify(q);const {reviewSha256,...body}=q;q.reviewSha256=hash(body);await assert.rejects(commit(f,q));assert.deepEqual(await record(f),initial);
 }
 f.w.clock.value=p.expiresAt;await assert.rejects(commit(f,p),/EXPIRED/);assert.equal(writes,0);
});
test('Generic observation cannot mint a retirement or make a retired record signed again',async t=>{
 const f=await setup(t),p=await prep(f);await assert.rejects(f.w.vault.observeInjective(f.r,RETIRED,{}),/TRANSITION/);
 const r=await commit(f,p);await assert.rejects(f.w.vault.observeInjective(r,'signed',{}),/TRANSITION/);
 const bad=clone(r);delete bad.retirement;assert.throws(()=>validateInjectiveRecord(bad,f.w.vault.data.accounts));bad.state='signed';bad.retirement=r.retirement;assert.throws(()=>validateInjectiveRecord(bad,f.w.vault.data.accounts));
});
test('Boundary uses the signed TxBody/AuthInfo/SignDoc, not rehashed display metadata',async t=>{
 const f=await setup(t),b=signedRecoveryBoundary(f.r);assert.equal(b.timeoutHeight,f.r.summary.timeoutHeight);
 for(const which of ['timeout','doc','sequence']){const r=clone(f.r),v=injectiveReviewFromSummary(r.summary);if(which==='timeout'){v.transaction.timeoutHeight='1';r.summary.timeoutHeight='1';}else if(which==='doc')v.transaction.signDocBase64=v.transaction.bodyBytesBase64;else v.account.sequence='1';r.summary.reviewJson=JSON.stringify(v);assert.throws(()=>signedRecoveryBoundary(r));}
});
test('Only an exact expired predecessor, not a confirmed or unknown one, can reuse sequence',async t=>{
 const f=await setup(t),p=await prep(f),r=await commit(f,p),next=await f.w.call('non-evm/injective/withdraw/prepare',withdrawBody(f.w,f.chain,{requestKey:'new'}));
 assert.doesNotThrow(()=>assertInjectiveSequenceAvailable([r],next.summary));
 for(const state of ['signed','broadcast-unknown','reported-confirmed','reported-reverted'])assert.throws(()=>assertInjectiveSequenceAvailable([{...r,state}],next.summary),/RESERVED/);
 const bad=clone(next.summary),v=injectiveReviewFromSummary(bad);v.anchor.height='140';bad.reviewJson=JSON.stringify(v);delete bad.review;assert.throws(()=>assertInjectiveSequenceAvailable([r],bad),/ANCHOR/);
});
test('Real REST legacy/sdk header non-security encoding differences are normalized; security fields must agree',async t=>{
 const f=await setup(t);expire(f);f.chain.state.mutate=d=>{if(d.block){d.block.header.proposer_address='BASE64';d.sdk_block={header:{...d.block.header,proposer_address:'injvalcons1encoded'}};}};
 const p=await f.w.call(PREP,{id:f.r.id});assert.ok(p.evidence.height);
 for(const key of ['height','time','chain_id']){f.chain.state.mutate=d=>{if(d.block)d.sdk_block={header:{...d.block.header,[key]:key==='height'?'1':key==='time'?new Date(NOW+1).toISOString():'other'}};};await assert.rejects(f.w.call(PREP,{id:f.r.id}),/BLOCK_INVALID/);}
});

test('Persisted retirement rejects contradictory prior submission/inclusion reports even when all hashes are recomputed',async t=>{
 const f=await setup(t),retired=await commit(f,await prep(f));
 for(const patch of [{reason:'SUBMISSION_STARTING',received:false},{reason:'INCLUDED_SUCCESS',received:true,code:0,height:'101'}]){
  const r=clone(retired);r.report={observedAt:NOW,transactionHash:r.signed.requestId,automaticRetry:false,finalityProven:false,...patch};
  const {retirement,...base}=r;const p=r.retirement.review;p.recordSha256=hash({...base,state:'signed'});const {reviewSha256,...body}=p;p.reviewSha256=hash(body);r.retirement.confirmation=p.reviewSha256;
  assert.throws(()=>validateInjectiveRecord(r,f.w.vault.data.accounts),/UNSENT_ONLY/);
 }
});
test('A prior read-only not-found report can be retained through retirement',async t=>{
 const f=await setup(t);const observed=await f.w.call('non-evm/injective/reconcile',{id:f.r.id});f.r=observed;assert.equal(observed.state,'signed');
 const r=await commit(f,await prep(f));assert.deepEqual(r.report,observed.report);assert.equal(r.state,RETIRED);validateInjectiveRecord(r,f.w.vault.data.accounts);
});
