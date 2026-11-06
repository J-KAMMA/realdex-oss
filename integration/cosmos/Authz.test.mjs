import {signAuthz,validateAuthzRecord} from '../../wallet/non-evm/cosmos-authz-codec.mjs';
import {storeFixture} from '../../wallet/test/fixtures.mjs';
import {Vault} from '../../wallet/lib/vault.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startSimd,simdWalletFixture,waitFor} from './fixture.mjs';
import {PASSWORD} from '../../wallet/test/fixtures.mjs';
import {decodeAuthz} from '../../wallet/test/cosmos-authz-wire.mjs';
let chain;
before(async()=>{chain=await startSimd({lastKey:0x70});});after(async()=>{await chain?.close();});
async function fixture(t,overrides={}){
  const f=await simdWalletFixture(chain,overrides,{decodeSimulation:raw=>decodeAuthz(raw,chain.chainId,async a=>(await chain.account(a)).account_number,{simulation:true})});t.after(()=>f.close());
  const key=chain.nextKey(),helper=await f.vault.addAccount({family:'cosmos',label:'DISPOSABLE DELEGATE',secretHex:Buffer.alloc(32,key).toString('hex')});
  const backup=await f.vault.backup();await f.vault.verifyBackup(backup.encrypted,PASSWORD);
  const params=(action,e={})=>({action,requestKey:action,feeAtomic:'800',gasLimit:'400000',...(action==='grant'?{grantee:helper.address,recipient:chain.to,limitAtomic:'3000000',expirationSeconds:String(Math.floor(Date.now()/1000)+3600)}:action==='execute'?{granter:f.account.address,recipient:chain.to,amountAtomic:'1000000'}:{grantee:helper.address}),...e});
  const prepare=(action,e={})=>f.call('non-evm/cosmos-authz/prepare',{accountId:action==='execute'?helper.id:f.account.id,networkId:f.network.id,payment:params(action,e)});
  const approve=async(p,broadcast=true)=>(await f.call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.confirmationText,broadcast})).record;
  const reconcile=r=>f.call('non-evm/cosmos-authz/reconcile',{id:r.id});
  const settled=r=>waitFor(async()=>{const v=await reconcile(r);return v.state==='reported-confirmed'?v:false;},18000);
  const status=()=>f.call('non-evm/cosmos-authz/status',{networkId:f.network.id,granter:f.account.address,grantee:helper.address});
  return {...f,helper,helperKey:key,params,prepareAuthz:prepare,approveAuthz:approve,reconcileAuthz:reconcile,settledAuthz:settled,authzStatus:status};
}
test('real SDK authz grant -> execute -> revoke; separate payer and on-chain allowance',async t=>{
  const f=await fixture(t),balanceBefore=await chain.balance(f.account.address),helperBefore=await chain.balance(f.helper.address),destBefore=await chain.balance(chain.to);
  const p=await f.prepareAuthz('grant');assert.equal(p.summary.granter,f.account.address);assert.equal(p.summary.limitAtomic,'3000000');assert.equal(f.state.sent,0);
  const grant=await f.settledAuthz(await f.approveAuthz(p));assert.equal(grant.report.completed,true);assert.equal(grant.report.received,false);assert.equal((await f.authzStatus()).grant.remainingAtomic,'3000000');
  const exec=await f.settledAuthz(await f.approveAuthz(await f.prepareAuthz('execute')));assert.equal(exec.report.received,true);assert.equal((await f.authzStatus()).grant.remainingAtomic,'2000000');
  assert.equal(await chain.balance(f.account.address),balanceBefore-1000000n-800n);assert.equal(await chain.balance(f.helper.address),helperBefore-800n);assert.equal(await chain.balance(chain.to),destBefore+1000000n);
  const revoke=await f.settledAuthz(await f.approveAuthz(await f.prepareAuthz('revoke')));assert.equal(revoke.report.received,false);assert.equal((await f.authzStatus()).grant,null);
  await assert.rejects(f.prepareAuthz('execute',{requestKey:'after-revoke'}),/GRANT_REQUIRED/);assert.equal(f.state.sent,3);
});
async function grant(f,extra={}){return f.settledAuthz(await f.approveAuthz(await f.prepareAuthz('grant',extra)));}
async function rawExecution(f,modify={}){
  const p=await f.prepareAuthz('execute',{requestKey:'raw-source'}),req=f.app.requests.get(p.id),payment={...req.intent.payment,...modify};
  return signAuthz(Buffer.alloc(32,f.helperKey),payment);
}
async function submitOutsideWallet(signed){
  const r=await fetch(chain.restUrl+'cosmos/tx/v1beta1/txs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tx_bytes:signed.txRawBase64,mode:'BROADCAST_MODE_SYNC'})});
  const v=await r.json();if(Number(v.tx_response?.code)!==0)return {code:Number(v.tx_response?.code??1),checkTx:true};
  return waitFor(async()=>{const x=await chain.get(chain.rpcUrl+'tx?hash=0x'+signed.requestId);return x.result?.tx_result??false;},16000);
}
test('real SDK completely consuming allowance deletes it and prevents another payment',async t=>{
 const f=await fixture(t);await grant(f,{limitAtomic:'1000000'});await f.settledAuthz(await f.approveAuthz(await f.prepareAuthz('execute')));assert.equal((await f.authzStatus()).grant,null);await assert.rejects(f.prepareAuthz('execute',{requestKey:'again'}),/GRANT_REQUIRED/);
});
for(const [label,mutate] of [
 ['overspend',{amountAtomic:'3000001'}],
 ['wrong recipient partial',f=>({recipient:f.helper.address})],
 ['wrong recipient entire budget',f=>({recipient:f.helper.address,amountAtomic:'3000000'})],
 ['wrong denomination',{denom:'ugas'}],
])test('CHAIN refuses '+label+' even when wallet prechecks are bypassed',async t=>{
 const f=await fixture(t);await grant(f);const before=await chain.balance(f.account.address),dest=await chain.balance(chain.to),beforeGrant=(await f.authzStatus()).grant;
 const signed=await rawExecution(f,typeof mutate==='function'?mutate(f):mutate),result=await submitOutsideWallet(signed);
 assert.notEqual(result.code,0);assert.equal(await chain.balance(f.account.address),before);assert.equal(await chain.balance(chain.to),dest);assert.deepEqual((await f.authzStatus()).grant,beforeGrant);
});
test('CHAIN refuses a previously signed delegate payment after owner revocation',async t=>{
 const f=await fixture(t);await grant(f);const signed=await rawExecution(f);await f.settledAuthz(await f.approveAuthz(await f.prepareAuthz('revoke')));const before=await chain.balance(f.account.address);const result=await submitOutsideWallet(signed);assert.notEqual(result.code,0);assert.equal(await chain.balance(f.account.address),before);
});
test('CHAIN refuses a previously signed payment once grant expiration passes',async t=>{
 const f=await fixture(t),exp=Math.floor(Date.now()/1000)+10;await grant(f,{expirationSeconds:String(exp)});const signed=await rawExecution(f);
 await waitFor(async()=>Date.parse((await chain.get(chain.rpcUrl+'block')).result.block.header.time)>exp*1000+1000,18000);
 const before=await chain.balance(f.account.address),r=await submitOutsideWallet(signed);assert.notEqual(r.code,0);assert.equal(await chain.balance(f.account.address),before);
});
test('owner cannot silently overwrite an existing grant; explicit revoke then regrant works',async t=>{
 const f=await fixture(t);await grant(f);await assert.rejects(f.prepareAuthz('grant',{requestKey:'overwrite',limitAtomic:'5000000'}),/REVOKE_BEFORE/);
 await f.settledAuthz(await f.approveAuthz(await f.prepareAuthz('revoke')));await grant(f,{requestKey:'new-budget',limitAtomic:'4000000'});assert.equal((await f.authzStatus()).grant.remainingAtomic,'4000000');
});
test('same request key is idempotent; changed grant contents are rejected',async t=>{
 const f=await fixture(t),u=f.params('grant');const body={accountId:f.account.id,networkId:f.network.id,payment:u};const p=await f.call('non-evm/cosmos-authz/prepare',body),r=await f.approveAuthz(p);
 const again=await f.call('non-evm/cosmos-authz/prepare',body);assert.equal(again.record.id,r.id);assert.equal(f.state.sent,1);
 await assert.rejects(f.call('non-evm/cosmos-authz/prepare',{...body,payment:{...u,limitAtomic:'4000000'}}),/CONTENT_CONFLICT/);
});
test('grant capability requires full conditions, not just the delegate address',async t=>{
 const f=await fixture(t),p=await f.prepareAuthz('grant');await assert.rejects(f.call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:f.helper.address,broadcast:true}),/CONFIRMATION/);assert.equal(f.state.sent,0);assert.equal((await f.vault.nonEvmRecords()).length,0);
});
test('signed grant blocks normal and offline payments using the same source sequence',async t=>{
 const f=await fixture(t),r=await f.approveAuthz(await f.prepareAuthz('grant'),false);
 await assert.rejects(f.prepare({requestKey:'bypass-bank-send'}),/UNRESOLVED/);
 const transfer=r.summary.transfer,q={requestKey:'offline-bypass',chainId:chain.chainId,hrp:'cosmos',to:chain.to,denom:'stake',amountAtomic:'1',feeDenom:'stake',feeAtomic:'500',gasLimit:'200000',accountNumber:transfer.accountNumber,sequence:String(BigInt(transfer.sequence)+1n),timeoutHeight:transfer.timeoutHeight,acknowledgeUnverifiedState:true};
 const pending=await f.call('non-evm/cosmos/prepare',{accountId:f.account.id,payment:q});await assert.rejects(f.call('non-evm/approve',{id:pending.id,intentId:pending.intentId,confirmation:chain.to,broadcast:false}),/UNRESOLVED/);assert.equal(f.state.sent,0);
});
test('disk write failure locks and prevents grant transmission',async t=>{
 const f=await fixture(t),p=await f.prepareAuthz('grant'),original=f.store.store.write;f.store.store.write=()=>{throw Error('SAVE_INJECTED');};
 try{await assert.rejects(f.approveAuthz(p));assert.equal(f.state.sent,0);assert.equal(f.vault.status().locked,true);}finally{f.store.store.write=original;}
});
test('a persisted signature is not sent when recording broadcast-start fails',async t=>{
 const f=await fixture(t),r=await f.approveAuthz(await f.prepareAuthz('grant'),false),original=f.store.store.write;f.store.store.write=()=>{throw Error('SAVE_INJECTED');};
 try{await assert.rejects(f.call('non-evm/cosmos-authz/submit',{id:r.id,confirmation:r.signed.requestId}));assert.equal(f.state.sent,0);}finally{f.store.store.write=original;}
});
test('lost submission response is reconciled without a second broadcast',async t=>{
 const f=await fixture(t),u=f.params('grant');f.state.drop=true;const p=await f.call('non-evm/cosmos-authz/prepare',{accountId:f.account.id,networkId:f.network.id,payment:u}),r=await f.approveAuthz(p);assert.equal(r.state,'broadcast-unknown');
 const x=await f.settledAuthz(r);assert.equal(x.report.completed,true);assert.equal(f.state.sent,1);await assert.rejects(f.call('non-evm/cosmos-authz/submit',{id:x.id,confirmation:x.signed.requestId}),/REBROADCAST/);
});
test('disappearing grant transaction withdraws completed observation and keeps signer blocked',async t=>{
 const f=await fixture(t),r=await grant(f);f.state.hide=true;const x=await f.reconcileAuthz(r);assert.equal(x.report.completed,false);assert.equal(x.state,'broadcast-unknown');await assert.rejects(f.prepareAuthz('revoke'),/UNRESOLVED/);
});
test('changing allowance after prepare stops the delegate before signing',async t=>{
 const f=await fixture(t);await grant(f);const p=await f.prepareAuthz('execute');const raw=await rawExecution(f,{amountAtomic:'500000'});assert.equal((await submitOutsideWallet(raw)).code,0);
 await assert.rejects(f.approveAuthz(p),/GRANT_CHANGED|SEQUENCE/);assert.equal(f.state.sent,1);
});
test('completed grant remains active while the PC wallet is locked',async t=>{
 const f=await fixture(t);await grant(f);const raw=await rawExecution(f);await f.call('lock');assert.equal((await submitOutsideWallet(raw)).code,0);assert.equal(f.vault.status().locked,true);
});
test('operator lock during simulation prevents old approval signing',async t=>{
 const f=await fixture(t),p=await f.prepareAuthz('grant');let ready,release;const hit=new Promise(r=>ready=r),hold=new Promise(r=>release=r);let once=false;
 f.state.delay=async info=>{if(info.path.endsWith('/simulate')&&!once){once=true;ready();await hold;}};
 const result=f.approveAuthz(p).then(()=>null,e=>e);await hit;await f.call('lock');release();assert.ok(await result instanceof Error);assert.equal(f.state.sent,0);
});
test('encrypted backup restores signed authorization and sequence reservation',async t=>{
 const f=await fixture(t),r=await f.approveAuthz(await f.prepareAuthz('grant'),false),b=await f.vault.backup(),other=storeFixture();t.after(()=>other.close());const v=new Vault(other.store);t.after(()=>v.lock());await v.restore(b.encrypted,PASSWORD);await v.unlock(PASSWORD);
 const [restored]=await v.nonEvmRecords();assert.deepEqual(restored,r);assert.throws(()=>validateAuthzRecord({...r,summary:{...r.summary,limitAtomic:'999999999'}},f.account),/BINDING/);
});
test('settings fingerprint change prevents transmission of an old grant',async t=>{
 const f=await fixture(t),r=await f.approveAuthz(await f.prepareAuthz('grant'),false);f.app.settings.cosmosNetworks=[{...f.network,maxFeeAtomic:'9000'}];await assert.rejects(f.call('non-evm/cosmos-authz/submit',{id:r.id,confirmation:r.signed.requestId}),/NETWORK_CHANGED/);assert.equal(f.state.sent,0);
});
test('no authz signing APIs are available to an untrusted client',async t=>{
 const f=await fixture(t);const r=await fetch(f.started.origin+'/api/non-evm/cosmos-authz/prepare',{method:'POST',headers:{origin:f.started.origin,authorization:'Bearer untrusted','content-type':'application/json'},body:JSON.stringify({accountId:f.account.id,networkId:f.network.id,payment:f.params('grant')})});assert.ok(r.status>=400);assert.equal(f.state.sent,0);
});
test('disabled broadcast remains disabled for native authorization',async t=>{
 const f=await fixture(t,{broadcastEnabled:false}),p=await f.prepareAuthz('grant');await assert.rejects(f.approveAuthz(p),/BROADCAST_DISABLED/);assert.equal(f.state.sent,0);
});
test('restoring a pre-spend backup cannot replenish the allowance stored on-chain',async t=>{
 const f=await fixture(t);await grant(f);const old=await f.vault.backup();await f.settledAuthz(await f.approveAuthz(await f.prepareAuthz('execute')));
 const store=storeFixture();t.after(()=>store.close());const v=new Vault(store.store);t.after(()=>v.lock());await v.restore(old.encrypted,PASSWORD);await v.unlock(PASSWORD);
 const engine=f.app.nonEvm.authzEngine;await assert.rejects(engine.prepare(f.network,v.account(f.helper.id),f.params('execute',{requestKey:'from-old-backup',amountAtomic:'2500000'})),/SPEND_LIMIT_EXCEEDED/);
 assert.equal((await f.authzStatus()).grant.remainingAtomic,'2000000');
});
