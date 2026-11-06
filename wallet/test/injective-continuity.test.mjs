/** Synthetic transport fault tests. The separate integration suite uses real nodes. */
import test from 'node:test';import assert from 'node:assert/strict';
import {continuityBlock,continuityReferences,checkInjectiveContinuity} from '../injective/continuity.mjs';
import {InjectiveOwnerEngine} from '../injective/engine.mjs';
import {chainFixture,walletFixture,approve,createSource,cancelBody,withdrawBody,NOW,BLOCK} from './injective-actions-fixture.mjs';
import {PrivateStore} from '../lib/storage.mjs';import {Vault} from '../lib/vault.mjs';import {PASSWORD} from './fixtures.mjs';
const CHAIN='injective-888';
const fakeReview=(h='100',hash=BLOCK)=>({chainId:CHAIN,endpoint:'http://127.0.0.1:1234',anchor:{height:h,hash,timeMs:NOW,chainId:CHAIN},account:{address:'synthetic',accountNumber:'7',publicKeyHex:'synthetic'}});
const rawBlock=(h='100',hash=BLOCK)=>({block_id:{hash},block:{header:{height:h,chain_id:CHAIN,time:new Date(NOW).toISOString()}}});
const record=(review,more={})=>({accountId:'owner',summary:{reviewJson:JSON.stringify(review)},...more});
const mockEngine=(modify=()=>{})=>{const calls=[];return {calls,now:()=>NOW,request:async(r,p)=>{calls.push(p);const h=p.endsWith('latest')?'200':p.split('/').at(-1),b=rawBlock(h);modify(b,p);return b;}};};
test('Accept matching lowercase, uppercase and canonical base64 block identities',()=>{
 for(const h of [BLOCK,BLOCK.toUpperCase(),Buffer.from(BLOCK,'hex').toString('base64')])assert.deepEqual(continuityBlock(rawBlock('100',h),CHAIN),fakeReview().anchor);
});
test('Both REST envelope types preserve exact block identity',()=>{
 const r=rawBlock();r.sdk_block=structuredClone(r.block);assert.equal(continuityBlock(r,CHAIN).height,'100');delete r.block;assert.equal(continuityBlock(r,CHAIN).height,'100');
});
for(const [name,change] of Object.entries({
 'chain id':r=>r.block.header.chain_id='injective-1',
 'missing block':r=>delete r.block,
 'missing hash':r=>delete r.block_id,
 'zero hash':r=>r.block_id.hash='0'.repeat(64),
 'short hash':r=>r.block_id.hash='1',
 'noncanonical base64':r=>r.block_id.hash=Buffer.from(BLOCK,'hex').toString('base64')+'=',
 'numeric height':r=>r.block.header.height=100,
 'zero height':r=>r.block.header.height='0',
 'overflow height':r=>r.block.header.height='18446744073709551616',
 'noncanonical height':r=>r.block.header.height='0100',
 'non-time':r=>r.block.header.time='yesterday',
 'invalid calendar':r=>r.block.header.time='2026-02-31T00:00:00Z',
 'conflicting time':r=>r.sdk_block={header:{...r.block.header,time:new Date(NOW+1).toISOString()}},
 'conflicting height':r=>r.sdk_block={header:{...r.block.header,height:'101'}},
 'conflicting chain':r=>r.sdk_block={header:{...r.block.header,chain_id:'other'}}
}))test('Reject malformed continuity block: '+name,()=>{const r=rawBlock();change(r);assert.throws(()=>continuityBlock(r,CHAIN));});
test('Compare only bounded distinct anchors but include all records in the rollback floor',async()=>{
 const e=mockEngine(),r=fakeReview('190'),records=Array.from({length:64},(_,i)=>record(fakeReview(String(i+1))));
 records.at(-1).report={received:true,height:'199'};
 const v=await checkInjectiveContinuity(e,r,records,'owner');assert.equal(v.heightFloor,'199');assert.equal(v.anchorsChecked,2);assert.equal(e.calls.length,3);
});
test('Current, earliest and most recent anchors are all checked when current is older than history',async()=>{
 const r=fakeReview('100'),records=[record(fakeReview('90')),record(fakeReview('110'))],e=mockEngine();
 const v=await checkInjectiveContinuity(e,r,records,'owner');assert.equal(v.anchorsChecked,3);assert.equal(e.calls.length,4);
});
test('Retirement checkpoint remains part of continuity and its height floor',()=>{
 const r=fakeReview('100'),rs=[record(r,{retirement:{check:{height:'141',blockHash:BLOCK,blockTimeMs:NOW}}})];
 const v=continuityReferences(r,rs,'owner');assert.equal(v.heightFloor,'141');assert.deepEqual(v.anchors.map(a=>a.height),['100','141']);
});
test('A higher received transaction height is not ignored when checking rollback',async()=>{
 const r=fakeReview(),rs=[record(r,{report:{received:true,height:'201'}})],e=mockEngine();await assert.rejects(checkInjectiveContinuity(e,r,rs,'owner'),/ROLLBACK/);assert.equal(e.calls.length,1);
});
test('Duplicate local height with conflicting hash fails without network',async()=>{
 const r=fakeReview(),rs=[record(fakeReview('100','22'.repeat(32)))],e=mockEngine();await assert.rejects(checkInjectiveContinuity(e,r,rs,'owner'),/HISTORY_CONFLICT/);assert.equal(e.calls.length,0);
});
test('A contradictory intermediate height is rejected even if not selected as a boundary',()=>{
 const r=fakeReview('150'),rs=[record(fakeReview('90')),record(fakeReview('100')),record(fakeReview('100','22'.repeat(32))),record(fakeReview('130'))];assert.throws(()=>continuityReferences(r,rs,'owner'),/HISTORY_CONFLICT/);
});
for(const name of ['endpoint','chainId','accountNumber','publicKeyHex','address'])test('Historical '+name+' cannot migrate implicitly',async()=>{
 const r=fakeReview(),old=fakeReview('90');
 if(name==='endpoint')old.endpoint='http://127.0.0.1:2345';else if(name==='chainId'){old.chainId='other';old.anchor.chainId='other';}else old.account[name]='other';
 const e=mockEngine();await assert.rejects(checkInjectiveContinuity(e,r,[record(old)],'owner'));assert.equal(e.calls.length,0);
});
test('Dedicated different account history does not bind this owner',async()=>{
 const old=fakeReview('90');old.endpoint='http://127.0.0.1:2345';const e=mockEngine();await checkInjectiveContinuity(e,fakeReview(),[record(old,{accountId:'other'})],'owner');assert.equal(e.calls.length,2);
});
test('Local journal limit is not bypassed',()=>assert.throws(()=>continuityReferences(fakeReview(),Array.from({length:65},()=>record(fakeReview())),'owner'),/HISTORY/));
for(const [name,change] of Object.entries({
 'hash':b=>b.block_id.hash='22'.repeat(32),
 'height':b=>b.block.header.height='199',
 'timestamp':b=>b.block.header.time=new Date(NOW+1).toISOString(),
 'missing/pruned':()=>{throw Error('INJECTIVE_RPC_HTTP_ERROR');}
}))test('Changed or absent exact anchor fails closed: '+name,async()=>{
 const e=mockEngine((b,p)=>{if(!p.endsWith('latest'))change(b);});await assert.rejects(checkInjectiveContinuity(e,fakeReview(),[],'owner'));
});
for(const time of [NOW-30001,NOW+2001])test('Stale or future latest node time rejected '+time,async()=>{const e=mockEngine((b,p)=>{if(p.endsWith('latest'))b.block.header.time=new Date(time).toISOString();});await assert.rejects(checkInjectiveContinuity(e,fakeReview(),[],'owner'),/STALE/);});
test('Guard is checked after each await and prevents later requests after a lock',async()=>{
 const e=mockEngine(),real=e.request;let locked=false;e.request=async(...a)=>{const r=await real(...a);locked=true;return r;};
 await assert.rejects(checkInjectiveContinuity(e,fakeReview(),[],'owner',{guard:()=>{if(locked)throw Error('LOCK_INTERRUPTED_OPERATION');}}),/LOCK_INTERRUPTED/);assert.equal(e.calls.length,1);
});

const submit=(w,r)=>w.call('non-evm/injective/submit',{id:r.id,confirmation:r.signed.requestId});
async function pending(w,c,kind,key='continuity'){
 if(kind==='order')return w.call('non-evm/injective/prepare',{accountId:w.account.id,review:await c.review(key)});
 if(kind==='cancel'){const source=await createSource(w,c);return w.call('non-evm/injective/cancel/prepare',cancelBody(w,c,source,{requestKey:key}));}
 return w.call('non-evm/injective/'+kind+'/prepare',withdrawBody(w,c,{requestKey:key}));
}
for(const kind of ['order','cancel','withdraw','deposit'])for(const phase of ['approval','first-send'])test(kind+' '+phase+' rejects replaced chain with same id/account before any signing save or send',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),p=await pending(w,c,kind);let r;if(phase==='first-send')r=await approve(w,p);
 const history=await w.vault.injectiveRecords(),disk=w.f.store.read(),sent=c.state.sent;let writes=0;const write=w.f.store.write.bind(w.f.store);w.f.store.write=(...a)=>{writes++;return write(...a);};
 c.state.mutate=d=>{if(d.block)d.block_id.hash='22'.repeat(32);};
 await assert.rejects(phase==='approval'?approve(w,p):submit(w,r),/CONTINUITY_ANCHOR_CHANGED/);
 assert.equal(writes,0);assert.equal(c.state.sent,sent);assert.deepEqual(await w.vault.injectiveRecords(),history);assert.equal(w.f.store.read(),disk);assert.equal(w.vault.status().locked,false);
});
test('A fresh review from a replaced chain cannot erase the completed prior history anchor',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c);await createSource(w,c);c.state.mutate=d=>{if(d.block)d.block_id.hash='22'.repeat(32);};
 const p=await pending(w,c,'deposit','after-replacement'),disk=w.f.store.read(),before=await w.vault.injectiveRecords();
 await assert.rejects(approve(w,p),/CONTINUITY/);assert.equal(w.f.store.read(),disk);assert.deepEqual(await w.vault.injectiveRecords(),before);assert.equal(c.state.sent,1);
});
test('Reconciliation cannot mark a matching transaction hash included on a changed chain',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),r=await approve(w,await pending(w,c,'deposit'));c.state.drop=true;await submit(w,r);
 const before=await w.vault.injectiveRecords(),disk=w.f.store.read();c.state.mutate=d=>{if(d.block)d.block_id.hash='22'.repeat(32);};
 await assert.rejects(w.call('non-evm/injective/reconcile',{id:r.id}),/CONTINUITY/);assert.deepEqual(await w.vault.injectiveRecords(),before);assert.equal(w.f.store.read(),disk);assert.equal(c.state.sent,1);
 c.state.mutate=null;assert.equal((await w.call('non-evm/injective/reconcile',{id:r.id})).state,'reported-confirmed');assert.equal(c.state.sent,1);
});
test('Node replacement while the receipt is returned does not commit the stale observation',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),r=await approve(w,await pending(w,c,'deposit'));await submit(w,r);
 const before=await w.vault.injectiveRecords(),disk=w.f.store.read();let swapped=false;
 c.state.mutate=(d,p)=>{if(p.endsWith(r.signed.requestId))swapped=true;if(d.block&&swapped)d.block_id.hash='22'.repeat(32);};
 await assert.rejects(w.call('non-evm/injective/reconcile',{id:r.id}),/CONTINUITY/);assert.deepEqual(await w.vault.injectiveRecords(),before);assert.equal(w.f.store.read(),disk);assert.equal(c.state.sent,1);
});
test('Impossible receipt heights cannot alter memory or encrypted history',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),r=await approve(w,await pending(w,c,'deposit'));await submit(w,r);
 const before=await w.vault.injectiveRecords(),disk=w.f.store.read();
 for(const h of ['0','100','102','18446744073709551615']){
  c.state.mutate=d=>{if(d.tx_response)d.tx_response.height=h;};
  await assert.rejects(w.call('non-evm/injective/reconcile',{id:r.id}),/RECEIPT_HEIGHT/);assert.deepEqual(await w.vault.injectiveRecords(),before);assert.equal(w.f.store.read(),disk);
 }
 assert.equal(c.state.sent,1);
});
test('Expired unsigned retirement cannot use a reset chain to discard the old transaction',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),r=await approve(w,await pending(w,c,'withdraw'));
 c.state.height=Number(r.summary.timeoutHeight)+1;const before=await w.vault.injectiveRecords(),disk=w.f.store.read();
 c.state.mutate=(d,p)=>{if(d.block&&p.endsWith('/100'))d.block_id.hash='22'.repeat(32);};
 await assert.rejects(w.call('non-evm/injective/recovery/prepare',{id:r.id}),/CONTINUITY/);assert.deepEqual(await w.vault.injectiveRecords(),before);assert.equal(w.f.store.read(),disk);assert.equal(c.state.sent,0);
});
test('Reopened encrypted Vault retains the pre-restart anchor without a data-schema migration',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),r=await approve(w,await pending(w,c,'deposit'));await w.shutdown();
 const s=new PrivateStore(w.f.directory),v=new Vault(s,{now:()=>NOW});await v.unlock(PASSWORD);
 try{const engine=new InjectiveOwnerEngine({now:()=>NOW}),old=(await v.injectiveRecords())[0],disk=s.read();c.state.mutate=d=>{if(d.block)d.block_id.hash='22'.repeat(32);};
 await assert.rejects(engine.broadcast(v,old),/CONTINUITY/);assert.equal(s.read(),disk);assert.deepEqual((await v.injectiveRecords())[0],old);assert.equal(c.state.sent,0);
 c.state.mutate=null;assert.equal((await engine.broadcast(v,old)).state,'broadcast');assert.equal(c.state.sent,1);assert.equal((await v.injectiveRecords())[0].signed.requestId,r.signed.requestId);
 }finally{await v.lock();s.close();}
});

test('Node replacement after recovery preparation cannot commit the previously approved retirement',async t=>{
 const c=await chainFixture(t),w=await walletFixture(t,c),r=await approve(w,await pending(w,c,'deposit'));
 c.state.height=Number(r.summary.timeoutHeight)+1;const proposal=await w.call('non-evm/injective/recovery/prepare',{id:r.id}),disk=w.f.store.read(),before=await w.vault.injectiveRecords();
 c.state.mutate=(d,p)=>{if(d.block&&p.endsWith('/100'))d.block_id.hash='22'.repeat(32);};
 await assert.rejects(w.call('non-evm/injective/recovery/retire',{id:r.id,review:proposal,confirmation:proposal.reviewSha256,transactionHash:r.signed.requestId}),/CONTINUITY/);
 assert.equal(w.f.store.read(),disk);assert.deepEqual(await w.vault.injectiveRecords(),before);assert.equal(c.state.sent,0);
});
