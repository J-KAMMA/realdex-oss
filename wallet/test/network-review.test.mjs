import test from 'node:test';import assert from 'node:assert/strict';
import {serverFixture,PASSWORD,GENESIS,TO} from './fixtures.mjs';
import {clone} from '../lib/guard.mjs';
import {keccak256} from '../../node/verified/keccak.mjs';
const newContract={address:TO,kind:'erc20',runtimeHash:keccak256('0x6000'),symbol:'SYNTHETIC',decimals:6,approvalCapAtomic:'1000000000'};
const next=f=>({...clone(f.network),contracts:[newContract]});
const apply=(f,d,patch={})=>f.call('networks/replace',{id:d.id,digest:d.digest,confirmation:d.confirmation,...patch});
test('Owner review is read-only; exact confirmation replaces the policy, locks and cancels pending requests/sessions',async()=>{
 const f=await serverFixture();try{
  let saved;f.app.saveSettings=s=>saved=clone(s);const old=JSON.stringify(f.app.settings),cipher=f.store.read();
  const pending=f.app.addRequest({kind:'connect',origin:'http://127.0.0.1:5173',chainId:'31337'});f.app.sessions.set('public-fake-session',{expiresAt:f.state.now+99999,origin:'http://127.0.0.1:5173'});
  const d=await f.call('networks/review',{network:next(f)});assert.equal(d.contractChanges[0].action,'added');assert.equal(d.contractsCertified,false);assert.equal(JSON.stringify(f.app.settings),old);assert.equal(f.store.read(),cipher);assert.equal(saved,undefined);
  const r=await apply(f,d);assert.equal(r.locked,true);assert.equal(f.vault.status().locked,true);assert.equal(f.app.sessions.size,0);assert.equal(pending.error,'NETWORK_POLICY_REPLACED');assert.equal(saved.networks[0].contracts[0].address,TO);assert.equal(f.state.sent.length,0);
  await f.vault.unlock(PASSWORD);assert.equal(f.app.settings.networks[0].contracts[0].decimals,6);assert.equal(f.store.read(),cipher);
 }finally{await f.close();}
});
test('Wrong confirmation and swapped review digest cannot change settings or lock the wallet',async()=>{
 const f=await serverFixture();try{const d=await f.call('networks/review',{network:next(f)});
  await assert.rejects(apply(f,d,{confirmation:'REPLACE 1 AND LOCK'}),/NETWORK_REVIEW_CONFIRMATION_REQUIRED/);
  await assert.rejects(apply(f,d,{digest:'0'.repeat(64)}),/NETWORK_REVIEW_EXPIRED_OR_CHANGED/);
  assert.equal(f.vault.status().locked,false);assert.equal(f.app.settings.networks[0].contracts.length,0);
 }finally{await f.close();}
});
test('Same chain with another genesis, mainnet and unchanged policies are not reviewable',async()=>{
 const f=await serverFixture();try{
  for(const [n,e] of [[{...next(f),genesisHash:'0x'+'99'.repeat(32)},/NETWORK_GENESIS_REPLACEMENT_FORBIDDEN/],[{...next(f),chainId:'999999'},/LOCAL_SIGNER_NETWORK_UNSUPPORTED/],[clone(f.network),/NETWORK_POLICY_UNCHANGED/]])await assert.rejects(f.call('networks/review',{network:n}),e);
 }finally{await f.close();}
});
test('A newer draft replaces the old draft and old settings changes are detected',async()=>{
 const f=await serverFixture();try{const a=await f.call('networks/review',{network:next(f)}),b=await f.call('networks/review',{network:{...next(f),maxSlippageBps:50}});
  await assert.rejects(apply(f,a),/NETWORK_REVIEW_EXPIRED_OR_CHANGED/);
  f.app.settings={...f.app.settings,allowedAppOrigins:[]};await assert.rejects(apply(f,b),/NETWORK_SETTINGS_CHANGED/);assert.equal(f.vault.status().locked,false);
 }finally{await f.close();}
});
test('Review expires after 90 seconds and cannot survive lock/unlock epochs',async()=>{
 const f=await serverFixture();try{let d=await f.call('networks/review',{network:next(f)});f.state.now+=90001;await assert.rejects(apply(f,d),/NETWORK_REVIEW_EXPIRED_OR_CHANGED/);
  d=await f.call('networks/review',{network:next(f)});f.vault.lock();await f.vault.unlock(PASSWORD);await assert.rejects(apply(f,d),/NETWORK_REVIEW_EXPIRED_OR_CHANGED/);
 }finally{await f.close();}
});
test('An active approval/broadcast blocks policy replacement without changing the live policy',async()=>{
 const f=await serverFixture();try{const d=await f.call('networks/review',{network:next(f)});f.app.activeApproval=true;
  await assert.rejects(apply(f,d),/APPROVAL_BUSY/);assert.equal(f.vault.status().locked,false);assert.equal(f.app.settings.networks[0].contracts.length,0);f.app.activeApproval=false;await apply(f,d);
 }finally{await f.close();}
});
test('Settings write failure leaves old settings and a locked wallet; no silent reopening or lost budget',async()=>{
 const f=await serverFixture();try{const old=JSON.stringify(f.app.settings),cipher=f.store.read();const d=await f.call('networks/review',{network:next(f)});f.app.saveSettings=()=>{throw Error('TEST_DISK_FULL');};
  await assert.rejects(apply(f,d),/TEST_DISK_FULL/);assert.equal(f.vault.status().locked,true);assert.equal(JSON.stringify(f.app.settings),old);assert.equal(f.store.read(),cipher);assert.equal(f.app.networkReview.draft,null);
 }finally{await f.close();}
});
test('Policy replacement stops AI credentials without refunding or rewriting encrypted grant history',async()=>{
 const {agentFixture}=await import('./agent-fixtures.mjs');const f=await agentFixture({mode:'auto'});try{
  const before=f.store.read();const d=await f.call('networks/review',{network:{...clone(f.network),maxSlippageBps:50}});await apply(f,d);
  await assert.rejects(f.agent('status',{}),/AGENT_UNAUTHORIZED|VAULT_LOCKED|AGENT_REACTIVATION_REQUIRED/);assert.equal(f.store.read(),before);
  await f.vault.unlock(PASSWORD);await assert.rejects(f.agent('status',{}),/AGENT_UNAUTHORIZED|AGENT_REACTIVATION_REQUIRED/);
  assert.equal(f.vault.data.agentPolicies.length,1);assert.equal(f.state.sent.length,0);
 }finally{await f.close();}
});
test('Agent credentials cannot perform owner policy review; stale async transfer preparations are epoch-invalidated',async()=>{
 const f=await serverFixture();try{
  let release;f.app.engine.prepare=async()=>{await new Promise(r=>release=r);return {id:'synthetic-intent',expiresAt:f.state.now+30000,summary:{}};};
  const preparing=f.call('transfers/prepare',{accountId:f.account.id,chainId:'31337',transfer:{asset:'native',recipient:TO,amount:'0.001'}});preparing.catch(()=>{});
  while(!release)await new Promise(r=>setTimeout(r,5));const d=await f.call('networks/review',{network:next(f)});await apply(f,d);release();
  await assert.rejects(preparing,/WALLET_LOCKED_DURING_RECHECK/);assert.equal(f.app.requests.size,0);
  const r=await fetch(f.start.origin+'/api/networks/review',{method:'POST',headers:{origin:f.start.origin,'content-type':'application/json',authorization:'Bearer '+'0'.repeat(64)},body:JSON.stringify({network:next(f)})});assert.equal(r.status,401);
 }finally{await f.close();}
});
