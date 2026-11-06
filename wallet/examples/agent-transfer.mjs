#!/usr/bin/env node
/** Read-only by default. Uses a limited agent capability from the environment. */
import {AgentWalletClient} from '../agent/client.mjs';
const token = process.env.REALDEX_AGENT_TOKEN;
delete process.env.REALDEX_AGENT_TOKEN;
if (!token) { console.error('Set REALDEX_AGENT_TOKEN through your local secret/environment manager.'); process.exit(1); }
const client = new AgentWalletClient({token, url: process.env.REALDEX_WALLET_URL ?? 'http://127.0.0.1:8790'});
try {
  const status = await client.status();
  console.log(JSON.stringify(status, null, 2)); // Only this grant's public account and policy; no keys.
  if (process.argv[2] === '--request-transfer') {
    const [recipient, amountAtomic, idempotencyKey] = process.argv.slice(3);
    if (!recipient || !amountAtomic || !idempotencyKey) throw Error('RECIPIENT_ATOMIC_AMOUNT_AND_STABLE_KEY_REQUIRED');
    try { console.log(JSON.stringify(await client.transfer({recipient, amountAtomic, idempotencyKey}), null, 2)); }
    catch (e) {
      console.error(e.message); // Coded errors only. Never retry using a fresh key after uncertainty.
      console.log(JSON.stringify(await client.result(idempotencyKey, {refresh: true}), null, 2));
      process.exitCode = 1;
    }
  }
} catch (e) { console.error(/^[A-Z0-9_]+$/.test(e.message) ? e.message : 'AGENT_EXAMPLE_FAILED'); process.exitCode = 1; }
finally { client.destroy(); }
