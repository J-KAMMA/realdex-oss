#!/usr/bin/env node
/** SYNTHETIC ONLY: disposable public-test key, isolated temporary vault, two mock RPCs. */
import {agentFixture, payment} from '../test/agent-fixtures.mjs';
import {AgentWalletClient} from './client.mjs';
const f = await agentFixture({mode: 'auto'});
const client = new AgentWalletClient({url: f.start.origin, token: f.grant.token});
try {
  const first = await client.transfer(payment('synthetic-demo-invoice', '50'));
  const again = await client.transfer(payment('synthetic-demo-invoice', '50'));
  let oversizedDenied = false;
  try { await client.transfer(payment('synthetic-demo-oversized', '101')); }
  catch (e) { oversizedDenied = e.message === 'AGENT_PER_TRANSFER_LIMIT'; }
  const observed = await client.result('synthetic-demo-invoice', {refresh: true});
  const {policy} = await client.status();
  console.log(JSON.stringify({mode: 'SYNTHETIC_RPC_NOT_REAL_EVM_OR_CHAIN',
    realFunds: false, persistentWalletCreated: false, privateTokensPrinted: false,
    receiptObservation: observed.reconciliationObservation,
    firstState: first.state, firstBroadcastState: first.broadcastState,
    idempotencyPreserved: first.requestId === again.requestId,
    outboundSubmissions: f.state.sent.length, oversizedDenied, usedAtomic: policy.usage.lifetimeAtomic,
    gasReservedWei: policy.usage.lifetimeFeeWei}, null, 2));
} finally { client.destroy(); await f.close(); }
