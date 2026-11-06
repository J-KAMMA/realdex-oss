import test from 'node:test';
import assert from 'node:assert/strict';
import {agentFixture,payment} from './agent-fixtures.mjs';
import {waitFor, TO} from './fixtures.mjs';
import {AgentWalletClient} from '../agent/client.mjs';
import {callAgentTool} from '../agent/tools.mjs';
async function use(fn){const f=await agentFixture({mode:'auto'});try{await fn(f);}finally{await f.close();}}
test('Payment preview is read-only: no reservations, file writes, signatures, pending prompts or sends',async()=>use(async f=>{
  const before=f.store.read(),expiresAt=f.vault.expiresAt;
  const r=await f.agent('preview',payment());assert.equal(r.canRequest,true);assert.equal(r.signatureCreated,false);assert.equal(r.reservationCreated,false);assert.equal(r.amountAtomic,'50');assert.equal(r.mode,'auto');assert.equal(f.store.read(),before);assert.equal(f.vault.expiresAt,expiresAt);assert.equal(f.state.sent.length,0);assert.equal(f.app.pending().length,0);assert.equal(f.vault.data.journal.length,0);
}));
test('Preview enforces recipient and budget caps before any RPC request',async()=>use(async f=>{
  const before=f.state.calls.length;await assert.rejects(f.agent('preview',{...payment(),recipient:'0x'+'56'.repeat(20)}),/RECIPIENT_DENIED/);await assert.rejects(f.agent('preview',payment('large','101')),/PER_TRANSFER_LIMIT/);assert.equal(f.state.calls.length,before);
}));
test('Preview cannot sneak calldata, different asset or float amount into a transfer',async()=>use(async f=>{
  for(const patch of [{data:'0x'},{asset:'other'},{amountAtomic:1}])await assert.rejects(f.agent('preview',{...payment(),...patch}));assert.equal(f.state.sent.length,0);
}));
test('Preview of an already used key returns saved result; conflicting content cannot create a new spend',async()=>use(async f=>{
  const sent=await f.agent('transfer',payment()),before=f.state.calls.length;
  const r=await f.agent('preview',payment());assert.equal(r.alreadyRequested,true);assert.equal(r.result.transactionHash,sent.transactionHash);assert.equal(f.state.calls.length,before);
  await assert.rejects(f.agent('preview',payment('invoice-001','51')),/IDEMPOTENCY_CONFLICT/);assert.equal(f.state.sent.length,1);
}));
test('SDK and MCP preview expose no capability/private data and allow no budget mutation',async()=>use(async f=>{
  const client=new AgentWalletClient({url:f.start.origin,token:f.grant.token});const r=await callAgentTool(client,'realdex_agent_preview',payment());assert.equal(r.structuredContent.canRequest,true);assert.equal(r.isError,false);
  const text=JSON.stringify(r);for(const secret of [f.grant.token,f.app.uiToken,'rawTransaction','secretHex'])assert.ok(!text.includes(secret));assert.equal((await f.agent('status')).policy.usage.count,0);
}));
test('Revocation during an in-flight preview prevents a late success result',async()=>use(async f=>{
  let release,entered=false;f.state.delay=async method=>{if(method==='eth_getBalance'&&!entered){entered=true;await new Promise(r=>release=r);}};
  const op=f.agent('preview',payment());await waitFor(()=>entered);await f.call('agents/revoke',{id:f.grant.policy.id});release();await assert.rejects(op,/UNAUTHORIZED|REVOKED/);assert.equal(f.state.sent.length,0);
}));
test('A preview does not reserve a price or allowance: the subsequent transfer rechecks changed balances',async()=>use(async f=>{
  assert.equal((await f.agent('preview',payment())).canRequest,true);f.state.balance='0x0';const r=await f.agent('transfer',payment());assert.equal(r.state,'failed-before-sign');assert.equal(f.state.sent.length,0);
}));
