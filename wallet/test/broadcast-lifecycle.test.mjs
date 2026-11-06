import test from 'node:test';import assert from 'node:assert/strict';
import {serverFixture,PASSWORD,TO,waitFor} from './fixtures.mjs';
async function signed(f){const i=await f.app.engine.prepare(f.network,f.account,{from:f.account.address,to:TO,value:'0x1',data:'0x'});return f.app.engine.sign(f.vault,f.network,i);}
function pause(f,method){let release,entered=false;const barrier=new Promise(r=>release=r);f.state.delay=async m=>{if(m===method){entered=true;await barrier;}};return {ready:()=>waitFor(()=>entered),release:()=>{f.state.delay=null;release();}};}
test('Owner rebroadcast keeps approval exclusion until the asynchronous RPC send actually finishes',async()=>{
 const f=await serverFixture();try{const record=await signed(f),gate=pause(f,'eth_chainId');const sending=f.call('rebroadcast',{id:record.id,confirm:record.signed.transactionHash});sending.catch(()=>{});await gate.ready();
  assert.equal(f.app.activeApproval,true);await assert.rejects(f.call('reconcile',{id:record.id}),/APPROVAL_BUSY/);
  const d=await f.call('networks/review',{network:{...f.network,maxSlippageBps:50}});await assert.rejects(f.call('networks/replace',{id:d.id,digest:d.digest,confirmation:d.confirmation}),/APPROVAL_BUSY/);
  gate.release();assert.equal((await sending).state,'broadcast');assert.equal(f.app.activeApproval,false);assert.equal(f.state.sent.length,1);
 }finally{await f.close();}
});
test('Lock/unlock during owner rebroadcast snapshot cannot resume and spend under the new epoch',async()=>{
 const f=await serverFixture();try{const record=await signed(f),gate=pause(f,'eth_chainId');const sending=f.call('rebroadcast',{id:record.id,confirm:record.signed.transactionHash});sending.catch(()=>{});await gate.ready();
  await f.call('lock');await f.call('unlock',{password:PASSWORD});gate.release();await assert.rejects(sending,/WALLET_LOCKED_DURING_BROADCAST/);
  assert.equal(f.state.sent.length,0);assert.equal((await f.vault.journal())[0].state,'signed');assert.equal(f.app.activeApproval,false);
 }finally{await f.close();}
});
test('Lock/unlock after transport starts retains uncertain durable state; a late RPC success is not written back',async()=>{
 const f=await serverFixture();try{const record=await signed(f),gate=pause(f,'eth_sendRawTransaction');const sending=f.call('rebroadcast',{id:record.id,confirm:record.signed.transactionHash});sending.catch(()=>{});await gate.ready();
  assert.equal((await f.vault.journal())[0].state,'broadcast-unknown');await f.call('lock');await f.call('unlock',{password:PASSWORD});gate.release();
  assert.equal((await sending).state,'broadcast-unknown');assert.equal(f.state.sent.length,1);assert.equal((await f.vault.journal())[0].state,'broadcast-unknown');assert.equal(f.app.activeApproval,false);
 }finally{await f.close();}
});
