import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PrivateStore} from '../../wallet/lib/storage.mjs';
import {Vault} from '../../wallet/lib/vault.mjs';
import {WalletServer} from '../../wallet/lib/server.mjs';
import {keyInfo} from '../../wallet/lib/keys.mjs';
import {preflightInjectiveLimitOrder} from '../../node/external/injective-preflight.mjs';
import {startInjective,orderRequest,waitFor} from './fixture.mjs';

const PASSWORD='public integration password, not a user secret';
const SECRET='46'.repeat(32);

async function ownerWallet(t,chain){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-injective-owner-'));
  const store=new PrivateStore(directory),vault=new Vault(store);
  await vault.create(PASSWORD);
  const account=await vault.addAccount({family:'evm',label:'Disposable Injective owner',secretHex:SECRET});
  const backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
  const app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]}}),started=await app.start(0);
  const call=async(route,body={})=>{const response=await fetch(started.origin+'/api/'+route,{method:'POST',headers:{origin:started.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json'},body:JSON.stringify(body)}),value=await response.json();if(!response.ok)throw Error(value.error);return value;};
  t.after(async()=>{try{await app.close();}catch{}fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,store,vault,account,app,call};
}

test('Owner wallet persists exact Injective signature before one real local-node submission',async t=>{
  const chain=await startInjective({actorSecretHexes:[SECRET]});t.after(()=>chain.close());
  assert.equal(keyInfo('evm',Buffer.from(SECRET,'hex')).address.toLowerCase(),keyInfo('evm',Buffer.from(SECRET,'hex')).address);
  const wallet=await ownerWallet(t,chain);
  const request=await orderRequest(chain,0,{side:'sell',quantity:'2',limitPrice:'11',requestKey:'wallet-real-order'});
  const review=await preflightInjectiveLimitOrder(request,{now:Date.now});
  const prepared=await wallet.call('non-evm/injective/prepare',{accountId:wallet.account.id,review});
  const before=(await chain.get('/cosmos/auth/v1beta1/accounts/'+chain.actors[0].address)).account.base_account.sequence;
  const approved=(await wallet.call('non-evm/approve',{id:prepared.id,intentId:prepared.intentId,confirmation:review.reviewSha256,broadcast:false})).record;
  assert.equal(approved.state,'signed');
  assert.equal((await chain.get('/cosmos/auth/v1beta1/accounts/'+chain.actors[0].address)).account.base_account.sequence,before,'signing must not mutate chain state');
  const stored=(await wallet.vault.injectiveRecords()).find(r=>r.id===approved.id);assert.equal(stored.signed.requestId,approved.signed.requestId);
  const sent=await wallet.call('non-evm/injective/submit',{id:approved.id,confirmation:approved.signed.requestId});
  assert.equal(sent.state,'broadcast');
  const receipt=await chain.included(approved.signed.requestId);assert.equal(receipt.code,0);assert.equal(receipt.txhash,approved.signed.requestId);
  const finalized=await waitFor(async()=>{const h=(await wallet.call('non-evm/history')).records.find(r=>r.id===approved.id);if(h.state==='reported-confirmed')return h;await wallet.call('non-evm/injective/reconcile',{id:approved.id});return false;},15000);
  assert.equal(finalized.report.transactionHash,approved.signed.requestId);assert.equal(finalized.report.received,true);assert.equal(finalized.report.automaticRetry,false);
  await assert.rejects(wallet.call('non-evm/injective/submit',{id:approved.id,confirmation:approved.signed.requestId}),/RESUBMISSION_FORBIDDEN/);
});
