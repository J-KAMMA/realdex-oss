/** Synthetic provider and real encrypted Vault tests. Not independent chain proofs. */
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {PrivateStore} from '../lib/storage.mjs';import {Vault} from '../lib/vault.mjs';import {PASSWORD} from './fixtures.mjs';
import {chainFixture,walletFixture,withdrawBody,approve,NOW} from './injective-actions-fixture.mjs';
import {SUBMISSION_EXPIRED,SUBMISSION_REVIEW_SCHEMA,SUBMISSION_RETIREMENT_SCHEMA,RETIRED,RECOVERY_SCHEMA,RETIREMENT_SCHEMA,validateRetirement,validateRetirementReview,submissionRetirementEligible} from '../injective/retirement.mjs';
import {validateInjectiveRecord,validateInjectiveJournal} from '../injective/records.mjs';
import {canonical,clone} from '../lib/guard.mjs';
const PREP='non-evm/injective/recovery/prepare',RETIRE='non-evm/injective/recovery/retire';
const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
async function setup(t,state='broadcast-unknown'){
 const chain=await chainFixture(t),w=await walletFixture(t,chain),signed=await approve(w,await w.call('non-evm/injective/withdraw/prepare',withdrawBody(w,chain)));
 const engine=w.app.nonEvm.injectiveEngine;let r;
 if(state==='reported-reverted'){
  chain.state.checkTxCode=13;r=await w.call('non-evm/injective/submit',{id:signed.id,confirmation:signed.signed.requestId});
  assert.equal(r.state,state);assert.equal(chain.state.sent,1);assert.equal(chain.state.sequence,0n);
 }else{
  r=await w.vault.observeInjective(signed,'broadcast-unknown',engine.report(signed.signed.requestId,'SUBMISSION_STARTING'));
  if(state==='broadcast')r=await w.vault.observeInjective(r,state,engine.report(r.signed.requestId,'RPC_ACCEPTED_NOT_CONFIRMED',{code:0}));
 }
 return {chain,w,signed,r,engine};
}
const expire=f=>{f.chain.state.height=Number(f.r.summary.timeoutHeight)+1;};
const prep=async f=>{expire(f);return f.w.call(PREP,{id:f.r.id});};
const finish=(f,p,extra={})=>f.w.call(RETIRE,{id:f.r.id,review:p,confirmation:p.reviewSha256,transactionHash:f.r.signed.requestId,...extra});
const latest=async f=>(await f.w.vault.injectiveRecords()).find(r=>r.id===f.r.id);
for(const state of ['broadcast-unknown','broadcast','reported-reverted']){
 test(state+': read-only expiry proposal preserves submission possibility; explicit save never broadcasts',async t=>{
  const f=await setup(t,state),before=f.w.f.store.read(),original=clone(f.r);let writes=0;const write=f.w.f.store.write.bind(f.w.f.store);f.w.f.store.write=(...a)=>{writes++;return write(...a);};
  const sends=f.chain.state.sent,p=await prep(f);assert.equal(writes,0);assert.equal(f.w.f.store.read(),before);assert.deepEqual(await latest(f),original);
  assert.equal(p.schema,SUBMISSION_REVIEW_SCHEMA);assert.equal(p.originalState,state);assert.equal(p.neverSubmittedByWallet,false);assert.equal(p.submissionMayHaveOccurred,true);
  for(const name of ['automaticRetryAllowed','settlementVerified','chainStateAuthenticated'])assert.equal(p[name],false);
  const r=await finish(f,p);assert.equal(r.state,SUBMISSION_EXPIRED);assert.equal(r.retirement.schema,SUBMISSION_RETIREMENT_SCHEMA);assert.equal(writes,1);assert.equal(f.chain.state.sent,sends);
  assert.deepEqual(r.report,original.report);assert.deepEqual(r.signed,original.signed);assert.deepEqual(r.summary,original.summary);validateRetirement(r);validateInjectiveJournal(f.w.vault.data);
  await assert.rejects(f.w.call('non-evm/injective/submit',{id:r.id,confirmation:r.signed.requestId}),/RESUBMISSION/);assert.equal(f.chain.state.sent,sends);
 });
 test(state+': not-found or wall-clock expiry alone, including exact timeout height, cannot retire',async t=>{
  const f=await setup(t,state);f.w.clock.value=f.r.summary.expiresAt+1;
  for(const h of [100,Number(f.r.summary.timeoutHeight)]){f.chain.state.height=h;await assert.rejects(f.w.call(PREP,{id:f.r.id}),/NOT_EXPIRED/);}
  assert.deepEqual(await latest(f),f.r);
 });
}
test('Positive CheckTx rejection does not release its sequence until the owner persists an expiry barrier',async t=>{
 const f=await setup(t,'reported-reverted');expire(f);
 const fresh=()=>f.w.call('non-evm/injective/withdraw/prepare',withdrawBody(f.w,f.chain,{requestKey:'review-new-fees'}));
 await assert.rejects(approve(f.w,await fresh()),/SEQUENCE_ALREADY_RESERVED/);
 const retired=await finish(f,await prep(f));f.chain.state.checkTxCode=0;
 const next=await approve(f.w,await fresh());assert.equal(next.summary.sequenceKey,retired.summary.sequenceKey);assert.notEqual(next.signed.requestId,retired.signed.requestId);
 assert.equal((await f.w.vault.injectiveRecords()).length,2);validateInjectiveJournal(f.w.vault.data);
 await f.w.call('non-evm/injective/submit',{id:next.id,confirmation:next.signed.requestId});assert.equal(f.chain.state.sent,2);assert.equal(f.chain.state.sequence,1n);
});
test('A still-unresolved unknown transaction blocks another owner signature',async t=>{
 const f=await setup(t);expire(f);await assert.rejects(f.w.call('non-evm/injective/withdraw/prepare',withdrawBody(f.w,f.chain,{requestKey:'not-retired'})),/UNRESOLVED/);
 assert.deepEqual(await latest(f),f.r);
});
for(const changed of ['sequence','account','chain','anchor','old-height','old-time','public-key'])test('Submitted expiry rejects '+changed+' despite a not-found response',async t=>{
 const f=await setup(t);expire(f);f.chain.state.mutate=(d,route)=>{
  if(d.account){if(changed==='sequence')d.account.base_account.sequence='1';if(changed==='account')d.account.base_account.account_number='8';if(changed==='public-key')d.account.base_account.pub_key={key:'wrong'};}
  if(d.block){if(changed==='chain')d.block.header.chain_id='another';if(changed==='old-height')d.block.header.height='1';if(changed==='old-time')d.block.header.time=new Date(NOW-60000).toISOString();if(changed==='anchor'&&route.endsWith('/blocks/100'))d.block_id.hash='22'.repeat(32);}
 };
 await assert.rejects(f.w.call(PREP,{id:f.r.id}));assert.deepEqual(await latest(f),f.r);
});
for(const n of [1,2,3,4])test('Receipt appearing on lookup '+n+' blocks expiry, including during owner confirmation',async t=>{
 const f=await setup(t);expire(f);let seen=0;const request=f.engine.request.bind(f.engine);
 f.engine.request=async(review,path,opts)=>path.endsWith(f.r.signed.requestId)&&++seen===n?{tx_response:{code:'0',height:'101',txhash:f.r.signed.requestId}}:request(review,path,opts);
 if(n<=2)await assert.rejects(f.w.call(PREP,{id:f.r.id}),/RECEIPT_AVAILABLE/);else{const p=await f.w.call(PREP,{id:f.r.id});await assert.rejects(finish(f,p),/RECEIPT_AVAILABLE/);}
 assert.deepEqual(await latest(f),f.r);
});
for(const which of ['confirmation','transactionHash'])test('Submitted expiry requires exact '+which+' before any request or save',async t=>{
 const f=await setup(t),p=await prep(f),n=f.chain.state.calls.length,raw=f.w.f.store.read();await assert.rejects(finish(f,p,{[which]:'bad'}),/CONFIRMATION/);assert.equal(f.chain.state.calls.length,n);assert.equal(f.w.f.store.read(),raw);
});
test('Submitted history can never use an unsent receipt or claim neverSubmitted, even with rehashed fields',async t=>{
 const f=await setup(t),p=await prep(f);
 for(const change of [q=>{q.neverSubmittedByWallet=true;},q=>{q.submissionMayHaveOccurred=false;},q=>{q.originalState='signed';},q=>{q.originalState='broadcast';},q=>{q.schema=RECOVERY_SCHEMA;delete q.originalState;delete q.submissionMayHaveOccurred;q.neverSubmittedByWallet=true;}]){
  const q=clone(p);change(q);const {reviewSha256,...b}=q;q.reviewSha256=hash(b);await assert.rejects(finish(f,q));assert.deepEqual(await latest(f),f.r);
 }
});
test('Included successes/failures and malformed rejection reports are never eligible',()=>{
 for(const state of ['reported-confirmed','reported-reverted','broadcast','broadcast-unknown'])for(const p of [{received:true,height:'101',code:1,reason:'INCLUDED_FAILURE'},{received:false,height:'101',code:13,reason:'CHECKTX_REJECTED'},{received:false,reason:'CHECKTX_REJECTED',code:0,actionEffect:{kind:'withdraw'} }])assert.equal(submissionRetirementEligible({state,report:p}),false);
 for(const code of [0,-1,undefined,'13',Infinity])assert.equal(submissionRetirementEligible({state:'reported-reverted',report:{received:false,code,reason:'CHECKTX_REJECTED'}}),false);
 assert.equal(submissionRetirementEligible({state:'reported-reverted',report:{received:false,code:13,reason:'UNCLASSIFIED'}}),false);
});
test('Generic observation cannot create the new expiry state; closed records cannot become sendable',async t=>{
 const f=await setup(t),p=await prep(f);await assert.rejects(f.w.vault.observeInjective(f.r,SUBMISSION_EXPIRED,{}),/TRANSITION/);
 const r=await finish(f,p);for(const state of ['signed','broadcast','broadcast-unknown','reported-reverted'])await assert.rejects(f.w.vault.observeInjective(r,state,r.report),/TRANSITION/);
});
test('An old proposal loses its compare-and-swap when reconciliation changes the stored report',async t=>{
 const f=await setup(t),p=await prep(f);await f.w.vault.observeInjective(f.r,'broadcast-unknown',f.engine.report(f.r.signed.requestId,'NOT_FOUND_DOES_NOT_PROVE_FAILURE'));
 await assert.rejects(finish(f,p),/BINDING|RECORD_CHANGED|SUPERSEDED/);
});
test('Account sequence change after inspection is rechecked before persistent retirement',async t=>{
 const f=await setup(t),p=await prep(f),raw=f.w.f.store.read();f.chain.state.sequence=1n;await assert.rejects(finish(f,p),/ACCOUNT_CHANGED/);assert.equal(f.w.f.store.read(),raw);
});
test('Expired owner confirmation and concurrent operation are rejected without saving',async t=>{
 const f=await setup(t),p=await prep(f);f.engine.active.add(f.r.accountId);await assert.rejects(finish(f,p),/BUSY/);f.engine.active.clear();f.w.clock.value=p.expiresAt;await assert.rejects(finish(f,p),/EXPIRED/);assert.deepEqual(await latest(f),f.r);
});
test('Epoch/authorization checks interrupt recovery without allowing a partial update',async t=>{
 const f=await setup(t),p=await prep(f),request=f.engine.request.bind(f.engine),raw=f.w.f.store.read();let once=true;
 f.engine.request=async(...a)=>{const result=await request(...a);if(once){once=false;await f.w.vault.lock();}return result;};
 await assert.rejects(finish(f,p));assert.equal(f.w.f.store.read(),raw);
});
for(const after of [false,true])test('Saving expiry failure '+(after?'after':'before')+' disk write locks Vault; reopen uses only real disk result',async t=>{
 const f=await setup(t),p=await prep(f),write=f.w.f.store.write.bind(f.w.f.store);
 f.w.f.store.write=(...a)=>{if(after)write(...a);throw Error('INJ10_INJECTED_WRITE_FAILURE');};await assert.rejects(finish(f,p),/WRITE_FAILURE/);assert.equal(f.w.vault.status().locked,true);f.w.f.store.write=write;
 await f.w.vault.unlock(PASSWORD);const r=await latest(f);assert.equal(r.state,after?SUBMISSION_EXPIRED:'broadcast-unknown');assert.deepEqual(r.signed,f.r.signed);assert.equal(f.chain.state.sent,0);
});
test('Encrypted reopen preserves uncertain history and allows only separately approved successor',async t=>{
 const f=await setup(t),r=await finish(f,await prep(f)),before=await f.w.vault.injectiveRecords();await f.w.shutdown();
 const store=new PrivateStore(f.w.f.directory),v=new Vault(store,{now:()=>NOW});try{await v.unlock(PASSWORD);assert.deepEqual(await v.injectiveRecords(),before);validateInjectiveJournal(v.data);assert.equal((await v.injectiveRecords())[0].retirement.review.originalState,'broadcast-unknown');}finally{await v.lock();store.close();}
});
test('Persisted schema cross-tagging and changed original submission report fail even after rehash',async t=>{
 const f=await setup(t),retired=await finish(f,await prep(f));
 for(const mutation of [r=>{r.state=RETIRED;},r=>{r.retirement.schema=RETIREMENT_SCHEMA;},r=>{r.retirement.review.originalState='signed';},r=>{r.report.received=true;r.report.height='101';},r=>{delete r.retirement;}]){
  const r=clone(retired);mutation(r);if(r.retirement){const {retirement,...b}=r,p=r.retirement.review;p.recordSha256=hash({...b,state:p.originalState});const {reviewSha256,...body}=p;p.reviewSha256=hash(body);r.retirement.confirmation=p.reviewSha256;}
  assert.throws(()=>validateInjectiveRecord(r,f.w.vault.data.accounts));
 }
});
test('Bad HTTP404 is not an expiry certificate and does not alter unknown history',async t=>{
 const f=await setup(t);expire(f);const fetchImpl=f.engine.fetchImpl;
 for(const [status,body] of [[404,'{}'],[404,'{"code":5,"message":"x","details":[1]}'],[503,'{"code":5,"message":"x"}']]){
  f.engine.fetchImpl=(u,o)=>u.endsWith(f.r.signed.requestId)?Promise.resolve(new Response(body,{status,headers:{'content-type':'application/json'}})):fetchImpl(u,o);
  await assert.rejects(f.w.call(PREP,{id:f.r.id}));assert.deepEqual(await latest(f),f.r);
 }
});
for(const kind of ['order','cancel','deposit'])test(kind+': original operation identity and signed bytes survive submitted-expiry retirement',async t=>{
 const {createSource,cancelBody}=await import('./injective-actions-fixture.mjs');
 const chain=await chainFixture(t),w=await walletFixture(t,chain);let p;
 if(kind==='order')p=await w.call('non-evm/injective/prepare',{accountId:w.account.id,review:await chain.review('new-order')});
 else if(kind==='cancel'){const source=await createSource(w,chain);p=await w.call('non-evm/injective/cancel/prepare',cancelBody(w,chain,source));}
 else p=await w.call('non-evm/injective/deposit/prepare',{...withdrawBody(w,chain,{requestKey:'new-deposit'})});
 const signed=await approve(w,p),engine=w.app.nonEvm.injectiveEngine,r=await w.vault.observeInjective(signed,'broadcast-unknown',engine.report(signed.signed.requestId,'SUBMISSION_STARTING'));
 const f={chain,w,r,engine};const s=chain.state.sent,out=await finish(f,await prep(f));assert.equal(out.state,SUBMISSION_EXPIRED);assert.deepEqual(out.signed,signed.signed);assert.equal(out.summary.operation,signed.summary.operation);assert.equal(chain.state.sent,s);
 validateInjectiveJournal(w.vault.data);
});
