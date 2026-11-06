import test from 'node:test';
import assert from 'node:assert/strict';
import {agentFixture, payment} from './agent-fixtures.mjs';
import {PASSWORD, TO, KEY, waitFor, storeFixture} from './fixtures.mjs';
import {Vault} from '../lib/vault.mjs';
import {AUTO_CONFIRMATION, MANUAL_CONFIRMATION, validateAgentData} from '../lib/agent-policy.mjs';
import {validateNetwork} from '../lib/network.mjs';
import {keccak256} from '../../node/verified/keccak.mjs';
const OTHER='0x'+'37'.repeat(20),TOKEN='0x'+'12'.repeat(20);
async function use(options, fn) { const f=await agentFixture(options);try {await fn(f);}finally{await f.close();} }
const history=f=>f.call('agents/history');
const requestByKey=async(f,key)=> (await history(f)).requests.find(r=>r.idempotencyKey===key);
async function approve(f,r) { const p=(await f.call('status')).pending.find(p=>p.agentRequestId===r.requestId);return f.call('approve',{id:p.id,intentId:p.intentId,confirm:TO}); }
async function tokenGrant(f,mode='auto') {
  f.state.code[TOKEN]='0x6000'; f.state.callResult='0x'+'0'.repeat(63)+'1'; f.state.tokenDecimals=6;
  f.app.settings.networks=[validateNetwork({...f.network,contracts:[{address:TOKEN,kind:'erc20',runtimeHash:keccak256('0x6000'),symbol:'TESTTOKEN',decimals:6,approvalCapAtomic:'1000000'}]})];
  return f.create({...f.rawPolicy,asset:TOKEN,mode});
}

test('Agent policy creation requires a bound preview and explicit automation phrase',async()=>use({},async f=>{
  const d=await f.call('agents/prepare',{policy:{...f.rawPolicy,mode:'auto'}});
  assert.equal(d.confirmation,AUTO_CONFIRMATION);assert.equal(d.token,undefined);
  await assert.rejects(f.call('agents/create',{draftId:d.draftId,digest:d.digest,confirmation:MANUAL_CONFIRMATION}),/CONFIRMATION/);
  await assert.rejects(f.call('agents/create',{draftId:d.draftId,digest:'0'.repeat(64),confirmation:AUTO_CONFIRMATION}),/CHANGED/);
  const created=await f.call('agents/create',{draftId:d.draftId,digest:d.digest,confirmation:AUTO_CONFIRMATION});assert.match(created.token,/^[a-f0-9]{64}$/);
  await assert.rejects(f.call('agents/create',{draftId:d.draftId,digest:d.digest,confirmation:AUTO_CONFIRMATION}),/EXPIRED/);
}));
test('Keys and agent bearer capabilities do not appear in public status or encrypted storage',async()=>use({},async f=>{
  const s=JSON.stringify(await f.call('status')),b=(await f.call('backup')).encrypted;
  for(const secret of [f.grant.token,KEY,'secretHex']){assert.ok(!s.includes(secret));assert.ok(!b.includes(secret));}
  const agent=JSON.stringify(await f.agent('status'));assert.ok(!agent.includes('secretHex'));assert.ok(!agent.includes(f.app.uiToken));assert.equal((await f.agent('status')).rawSigning,false);
}));
test('Agent API rejects foreign/browser Origin, fetch-site, wrong token and UI capability',async()=>use({},async f=>{
  for(const headers of [{origin:'https://attacker.invalid'},{origin:f.start.origin},{'sec-fetch-site':'same-origin'},{'x-realdex-agent':'0'}]) assert.ok((await f.agentHttp('status',{},f.grant.token,headers)).status>=400);
  for(const token of [f.app.uiToken,'0'.repeat(64)]) assert.equal((await f.agentHttp('status',{},token)).status,401);
  const result=await fetch(f.start.origin+'/api/unlock',{method:'POST',headers:{origin:f.start.origin,authorization:'Bearer '+f.grant.token,'content-type':'application/json'},body:JSON.stringify({password:PASSWORD})});assert.equal(result.status,401);
}));
test('Agent methods never expose unlock, approvals, arbitrary signing or policy changes',async()=>use({},async f=>{
  for(const method of ['unlock','create','approve','revoke','sign','eth_sendRawTransaction','swaps','bridges','agents/create']) await assert.rejects(f.agent(method,{}),/DENIED/);
  for(const field of ['data','chainId','asset','from','gas','policyId']) await assert.rejects(f.agent('transfer',{...payment(),[field]:'override'}),/SCHEMA/);
  assert.equal(f.state.sent.length,0);
}));
test('Recipient and single payment limits fail before RPC calls or budget reservation',async()=>use({},async f=>{
  const before=f.state.calls.length;
  await assert.rejects(f.agent('transfer',{...payment(),recipient:OTHER}),/RECIPIENT_DENIED/);
  await assert.rejects(f.agent('transfer',payment('excess','101')),/PER_TRANSFER/);
  assert.equal(f.state.calls.length,before);assert.equal((await history(f)).requests.length,0);
}));
test('Manual mode reserves budget but cannot sign until a local confirmation',async()=>use({},async f=>{
  const r=await f.agent('transfer',payment());assert.equal(r.state,'awaiting-approval');assert.equal(f.state.sent.length,0);assert.equal((await f.call('journal')).records.length,0);
  assert.equal((await f.agent('status')).policy.usage.lifetimeAtomic,'50');
  const result=await approve(f,r);assert.equal(result.result.state,'signed');assert.equal(result.result.broadcastState,'broadcast');assert.equal(f.state.sent.length,1);
  assert.ok(!JSON.stringify(await f.agent('history')).includes('rawTransaction'));
}));
test('Rejected unsigned request releases reservation and same key cannot create a new payment',async()=>use({},async f=>{
  const r=await f.agent('transfer',payment());const p=(await f.call('status')).pending.find(p=>p.agentRequestId===r.requestId);await f.call('reject',{id:p.id});
  assert.equal((await f.agent('status')).policy.usage.count,0);assert.equal((await f.agent('transfer',payment())).state,'cancelled');assert.equal(f.state.sent.length,0);
}));
test('Automatic mode signs and sends without a per-payment UI approval within bounds',async()=>use({mode:'auto'},async f=>{
  const expiry=f.vault.expiresAt;const r=await f.agent('transfer',payment());assert.equal(r.state,'signed');assert.equal(r.broadcastState,'broadcast');assert.equal(f.state.sent.length,1);
  const j=(await f.call('journal')).records[0];assert.equal(j.agent.policyId,f.grant.policy.id);assert.equal(j.agent.requestId,r.requestId);
  assert.equal(f.vault.expiresAt,expiry,'AI signing must not renew the unlock timeout');
  assert.equal((await f.agent('status')).policy.usage.lifetimeFeeWei,'75600000000000');
}));
test('Repeated key returns same persisted result without re-signing or re-sending',async()=>use({mode:'auto'},async f=>{
  const first=await f.agent('transfer',payment()),second=await f.agent('transfer',payment());assert.equal(second.requestId,first.requestId);assert.equal(second.transactionHash,first.transactionHash);assert.equal(f.state.sent.length,1);
  await assert.rejects(f.agent('transfer',payment('invoice-001','51')),/IDEMPOTENCY_CONFLICT/);
  assert.equal((await f.agent('result',{idempotencyKey:'invoice-001'})).transactionHash,first.transactionHash);
}));
test('Concurrent duplicate payment keys produce at most one signature and outbound call',async()=>use({mode:'auto'},async f=>{
  const results=await Promise.all(Array.from({length:8},()=>f.agent('transfer',payment())));assert.equal(new Set(results.map(r=>r.requestId)).size,1);assert.equal(f.state.sent.length,1);assert.equal((await f.call('journal')).records.length,1);
}));
test('Concurrent different payments cannot spend the same remaining allowance',async()=>use({mode:'auto'},async f=>{
  const grant=await f.create({...f.rawPolicy,mode:'auto',limits:{...f.rawPolicy.limits,rolling24hAtomic:'100',lifetimeAtomic:'100'}});
  const results=await Promise.allSettled([f.agent('transfer',payment('a','75'),grant.token),f.agent('transfer',payment('b','75'),grant.token)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(f.state.sent.length,1);
  assert.equal((await f.agent('status',{},grant.token)).policy.usage.lifetimeAtomic,'75');
}));
test('Independent agent grants cannot see or claim each other\'s request history',async()=>use({mode:'auto'},async f=>{
  const first=await f.agent('transfer',payment());const other=await f.create({...f.rawPolicy,label:'Other agent'});
  assert.equal((await f.agent('history',{},other.token)).requests.length,0);assert.equal((await f.agent('result',{idempotencyKey:'invoice-001'},other.token)).state,'not-found');
  assert.equal((await f.agent('history')).requests[0].requestId,first.requestId);
}));
test('Lifelong and rolling gas budgets are independent of token budgets',async()=>use({mode:'auto'},async f=>{
  const grant=await f.create({...f.rawPolicy,mode:'auto',limits:{...f.rawPolicy.limits,perTxFeeWei:'80000000000000',rolling24hFeeWei:'80000000000000',lifetimeFeeWei:'80000000000000'}});
  const first=await f.agent('transfer',payment('first','1'),grant.token);assert.equal(first.state,'signed');f.state.nonce='0x1';
  await assert.rejects(f.agent('transfer',payment('second','1'),grant.token),/FEE_LIMIT/);assert.equal(f.state.sent.length,1);
}));
test('Prepared gas cap over the agent per-transaction budget never reaches a signer',async()=>use({},async f=>{
  const grant=await f.create({...f.rawPolicy,mode:'auto',limits:{...f.rawPolicy.limits,perTxFeeWei:'1'}});
  const r=await f.agent('transfer',payment(),grant.token);assert.equal(r.state,'failed-before-sign');assert.equal(r.error,'AGENT_PER_TX_FEE_LIMIT');assert.equal(f.state.sent.length,0);
  assert.equal((await f.agent('status',{},grant.token)).policy.usage.count,0);
}));
test('ERC20 transfers bind token, decimals, amount and exact transfer calldata',async()=>use({},async f=>{
  const grant=await tokenGrant(f);const r=await f.agent('transfer',payment('token','99'),grant.token);assert.equal(r.state,'signed');assert.equal(r.broadcastState,'broadcast');
  const j=(await f.call('journal')).records[0];assert.equal(j.summary.to,TOKEN);assert.equal(j.summary.operation,'erc20-transfer');assert.equal(j.summary.assetMoves[0].decimals,6);assert.equal(j.summary.amountAtomic,'99');
}));
for(const scenario of ['false-return','decimals-changed','insufficient-token','runtime-changed']) test(`ERC20 ${scenario} cannot consume an agent signature`,async()=>use({},async f=>{
  const grant=await tokenGrant(f);if(scenario==='false-return')f.state.callResult='0x'+'0'.repeat(64);if(scenario==='decimals-changed')f.state.tokenDecimals=18;if(scenario==='insufficient-token')f.state.tokenBalance=0n;if(scenario==='runtime-changed')f.state.code[TOKEN]='0x6001';
  const r=await f.agent('transfer',payment(),grant.token);assert.equal(r.state,'failed-before-sign');assert.equal(f.state.sent.length,0);assert.equal((await f.call('journal')).records.length,0);
}));
test('RPC disagreement fails closed and releases only the unsigned reservation',async()=>use({mode:'auto'},async f=>{
  f.state.secondMismatch='eth_getBalance';const r=await f.agent('transfer',payment());assert.equal(r.state,'failed-before-sign');assert.equal(r.error,'RPC_DISAGREEMENT');assert.equal(f.state.sent.length,0);assert.equal((await f.agent('status')).policy.usage.count,0);
}));
test('A transfer of native funds to a contract is not silently converted into an arbitrary call',async()=>use({mode:'auto'},async f=>{
  f.state.code[TO]='0x6000';const r=await f.agent('transfer',payment());assert.equal(r.error,'NATIVE_CONTRACT_TRANSFER_UNSUPPORTED');assert.equal(f.state.sent.length,0);
}));
test('Connection loss after submission remains charged; duplicates never retry',async()=>use({mode:'auto'},async f=>{
  f.state.dropSend=true;const r=await f.agent('transfer',payment());assert.equal(r.state,'signed');assert.equal(r.broadcastState,'broadcast-unknown');assert.equal(f.state.sent.length,1);
  assert.equal((await f.agent('status')).policy.usage.lifetimeAtomic,'50');assert.equal((await f.agent('transfer',payment())).transactionHash,r.transactionHash);assert.equal(f.state.sent.length,1);
  await assert.rejects(f.call('agents/cancel',{requestId:r.requestId}),/SIGNED_PAYMENT/);
}));
test('Revocation during RPC preparation prevents signing and sends',async()=>use({mode:'auto'},async f=>{
  let release,entered=false;f.state.delay=async method=>{if(method==='eth_getBalance'&&!entered){entered=true;await new Promise(r=>release=r);}};
  const operation=f.agent('transfer',payment());await waitFor(()=>entered);await f.call('agents/revoke',{id:f.grant.policy.id});release();const r=await operation;
  assert.equal(r.state,'failed-before-sign');assert.equal(f.state.sent.length,0);assert.equal((await f.call('journal')).records.length,0);
}));
test('Revocation after durable signing but before broadcast retains charge and blocks send',async()=>use({mode:'auto'},async f=>{
  let release,entered=false;const original=f.app.engine.broadcast.bind(f.app.engine);f.app.engine.broadcast=async(...args)=>{entered=true;await new Promise(r=>release=r);return original(...args);};
  const operation=f.agent('transfer',payment());await waitFor(()=>entered);await f.call('agents/revoke',{id:f.grant.policy.id});release();const r=await operation;
  assert.equal(r.state,'signed');assert.equal(r.broadcastState,'signed');assert.equal(f.state.sent.length,0);assert.equal(f.app.agents.list()[0].usage.lifetimeAtomic,'50');
}));
test('Stop-all invalidates in-flight authority without needing the signing queue',async()=>use({mode:'auto'},async f=>{
  let release,entered=false;f.state.delay=async m=>{if(m==='eth_getBalance'&&!entered){entered=true;await new Promise(r=>release=r);}};
  const operation=f.agent('transfer',payment());await waitFor(()=>entered);await f.call('agents/stop');release();const result=await operation;
  assert.equal(result.state,'failed-before-sign');assert.equal(f.state.sent.length,0);await assert.rejects(f.agent('status'),/UNAUTHORIZED/);
}));
test('Lock during preparation blocks signing, preserves an unresolved reservation for owner recovery',async()=>use({mode:'auto'},async f=>{
  let release,entered=false;f.state.delay=async m=>{if(m==='eth_getBalance'&&!entered){entered=true;await new Promise(r=>release=r);}};
  const operation=f.agent('transfer',payment());await waitFor(()=>entered);await f.call('lock');release();await assert.rejects(operation,/UNCERTAIN/);assert.equal(f.state.sent.length,0);
  await f.call('unlock',{password:PASSWORD});const r=(await history(f)).requests[0];assert.equal(r.state,'reserved');await f.call('agents/cancel',{requestId:r.requestId});assert.equal(f.app.agents.list()[0].usage.count,0);
}));
test('Lock and unlock never reactivate old agent tokens; explicit rotation preserves spent amount',async()=>use({mode:'auto'},async f=>{
  await f.agent('transfer',payment());await f.call('lock');await f.call('unlock',{password:PASSWORD});await assert.rejects(f.agent('status'),/UNAUTHORIZED/);
  assert.equal(f.app.agents.list()[0].activated,false);
  const next=await f.call('agents/activate',{id:f.grant.policy.id,confirmation:AUTO_CONFIRMATION});assert.notEqual(next.token,f.grant.token);assert.equal((await f.agent('status',{},next.token)).policy.usage.lifetimeAtomic,'50');
}));
test('Restore preserves charged history but permanently revokes copied agent policies',async()=>use({mode:'auto'},async f=>{
  await f.agent('transfer',payment());const b=await f.call('backup'),other=storeFixture();try{const v=new Vault(other.store);await v.restore(b.encrypted,PASSWORD);await v.unlock(PASSWORD);assert.equal(v.data.agentPolicies[0].status,'revoked');assert.equal(v.data.agentPolicies[0].tokenHash,null);assert.equal(v.data.agentRequests[0].state,'signed');validateAgentData(v.data);v.lock();}finally{other.close();}
}));
test('Agent reads and sends do not extend the owner auto-lock window',async()=>use({mode:'auto'},async f=>{
  const expiry=f.vault.expiresAt;f.state.now+=1000;await f.agent('status');await f.agent('balance');await f.agent('transfer',payment());assert.equal(f.vault.expiresAt,expiry);
  f.state.now=expiry;await assert.rejects(f.agent('status'),/LOCKED|UNAUTHORIZED/);assert.equal(f.vault.status().locked,true);
}));
test('Policy expiry and backward clock prevent new automated payments',async()=>use({},async f=>{
  const grant=await f.create({...f.rawPolicy,expiresAt:f.state.now+1000});f.state.now+=1001;await assert.rejects(f.agent('transfer',payment(),grant.token),/EXPIRED/);assert.equal(f.state.sent.length,0);
  f.state.now-=2000;await assert.rejects(f.agent('status'),/LOCKED|UNAUTHORIZED/);
}));
test('Changed network configuration invalidates previously issued agent authority',async()=>use({},async f=>{
  f.app.settings.networks=[validateNetwork({...f.network,symbol:'CHANGED'})];await assert.rejects(f.agent('transfer',payment()),/NETWORK_POLICY_CHANGED/);assert.equal(f.state.sent.length,0);
}));
test('Disk failure while atomically recording signature returns no signed transaction or outbound call',async()=>use({mode:'auto'},async f=>{
  const original=f.store.write.bind(f.store);let writes=0;f.store.write=(...args)=>{if(++writes===3)throw Error('SIMULATED_DISK_FAILURE');return original(...args);};
  await assert.rejects(f.agent('transfer',payment()),/UNCERTAIN/);assert.equal(f.state.sent.length,0);assert.equal(f.vault.status().locked,true);f.store.write=original;
  await f.call('unlock',{password:PASSWORD});assert.equal((await f.call('journal')).records.length,0);assert.equal((await history(f)).requests[0].state,'awaiting-approval');
}));
test('Disk failure recording pre-broadcast ambiguity stops IO but preserves signed reservation',async()=>use({mode:'auto'},async f=>{
  const original=f.store.write.bind(f.store);let writes=0;f.store.write=(...args)=>{if(++writes===4)throw Error('SIMULATED_DISK_FAILURE');return original(...args);};
  await assert.rejects(f.agent('transfer',payment()),/UNCERTAIN/);assert.equal(f.state.sent.length,0);f.store.write=original;await f.call('unlock',{password:PASSWORD});
  assert.equal((await f.call('journal')).records[0].state,'signed');assert.equal(f.app.agents.list()[0].usage.lifetimeAtomic,'50');
}));
test('Malformed restored agent/journal links are rejected after authentication',async()=>use({mode:'auto'},async f=>{
  await f.agent('transfer',payment());f.vault.data.agentRequests[0].amountAtomic='49';f.vault.save();f.vault.lock();await assert.rejects(f.vault.unlock(PASSWORD),/AUTHENTICATION_FAILED/);
}));
test('Agent reservation and grant storage are inside encrypted backup, not plaintext settings',async()=>use({},async f=>{
  await f.agent('transfer',{...payment(),note:'private invoice test string'});const encrypted=f.store.read();for(const text of ['private invoice test string',f.grant.policy.id,TO])assert.ok(!encrypted.includes(text));assert.ok(!JSON.stringify(f.app.settings).includes(f.grant.policy.id));
}));
test('Standard send form API creates canonical transfer without any agent authority',async()=>use({},async f=>{
  const r=await f.call('transfers/prepare',{accountId:f.account.id,chainId:'31337',transfer:{asset:'native',recipient:TO,amount:'0.000000000000000001'}});assert.equal(r.summary.amountAtomic,'1');assert.equal(r.transfer.amountAtomic,'1');assert.equal((await f.call('journal')).records.length,0);
  const receive=await f.call('transfers/receive',{accountId:f.account.id,chainId:'31337',asset:'native',amount:'0.1'});const parsed=await f.call('transfers/parse-uri',{chainId:'31337',uri:receive.uri});assert.equal(parsed.recipient,f.account.address);assert.equal(parsed.amount,'0.1');
  const balance=await f.call('transfers/balance',{accountId:f.account.id,chainId:'31337',asset:'native'});assert.equal(balance.nativeAtomic,String(BigInt(f.state.balance)));
}));

test('Agent API rate exhaustion cannot disable owner emergency stop or lock',async()=>use({},async f=>{
  f.app.agentBudget={at:f.state.now,n:600};assert.equal((await f.agentHttp('status')).status,429);assert.equal((await f.call('status')).locked,false);
  f.app.budget={at:f.state.now,n:600};assert.equal((await f.call('agents/stop')).stopped,true);assert.equal((await f.call('lock')).locked,true);
}));
test('Owner cancellation during a pending manual signature recheck stops signing',async()=>use({},async f=>{
  const r=await f.agent('transfer',payment());let release,entered=false;
  f.state.delay=async m=>{if(m==='eth_getBalance'&&!entered){entered=true;await new Promise(r=>release=r);}};
  const operation=approve(f,r);await waitFor(()=>entered);await f.call('agents/cancel',{requestId:r.requestId});release();await assert.rejects(operation,/NOT_READY|REQUEST_NOT_PROCESSING/);assert.equal(f.state.sent.length,0);assert.equal(f.app.agents.list()[0].usage.count,0);
}));
test('AI receipt refresh reads a bound successful receipt without another transfer or budget refund',async()=>use({mode:'auto'},async f=>{
  const r=await f.agent('transfer',payment());const journal=(await f.call('journal')).records[0];
  f.state.receipt={transactionHash:r.transactionHash,from:journal.summary.from,to:journal.summary.to,blockNumber:'0x10',blockHash:f.state.block,status:'0x1',logs:[]};
  const result=await f.agent('result',{idempotencyKey:'invoice-001',refresh:true});
  assert.equal(result.broadcastState,'reported-confirmed');assert.equal(result.receiptObservation.transactionReportedSuccessful,true);assert.equal(result.receiptObservation.finalityVerified,false);
  assert.equal(f.state.sent.length,1);assert.equal((await f.agent('status')).policy.usage.lifetimeAtomic,'50');
  assert.equal((await f.agent('result',{idempotencyKey:'invoice-001',refresh:true})).broadcastState,'reported-confirmed');
}));
test('Missing receipt during AI refresh is uncertainty, not a refunded or retried payment',async()=>use({mode:'auto'},async f=>{
  f.state.dropSend=true;await f.agent('transfer',payment());const r=await f.agent('result',{idempotencyKey:'invoice-001',refresh:true});
  assert.equal(r.reconciliationObservation,'not-found-does-not-prove-failure');assert.equal(r.state,'signed');assert.equal(f.state.sent.length,1);assert.equal((await f.agent('status')).policy.usage.lifetimeAtomic,'50');
}));
test('Receipt refresh cannot observe another grant and rejects nonboolean refresh flags',async()=>use({mode:'auto'},async f=>{
  await f.agent('transfer',payment());const other=await f.create({...f.rawPolicy,mode:'auto'});const before=f.state.calls.length;
  assert.equal((await f.agent('result',{idempotencyKey:'invoice-001',refresh:true},other.token)).state,'not-found');assert.equal(f.state.calls.length,before);
  await assert.rejects(f.agent('result',{idempotencyKey:'invoice-001',refresh:'yes'}),/REFRESH_INVALID/);
}));
test('Revocation during read-only receipt refresh rejects late data and never transmits funds',async()=>use({mode:'auto'},async f=>{
  await f.agent('transfer',payment());const original=f.app.engine.reconcile.bind(f.app.engine);let release,started;
  const entered=new Promise(r=>started=r);f.app.engine.reconcile=async(...args)=>{started();await new Promise(r=>release=r);return original(...args);};
  const waiting=f.agent('result',{idempotencyKey:'invoice-001',refresh:true});await entered;await f.call('agents/revoke',{id:f.grant.policy.id});release();
  await assert.rejects(waiting,/UNAUTHORIZED|REVOKED/);assert.equal(f.state.sent.length,1);
}));
