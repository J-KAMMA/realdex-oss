import {serverFixture, TO} from './fixtures.mjs';
import {AUTO_CONFIRMATION, MANUAL_CONFIRMATION} from '../lib/agent-policy.mjs';
export async function agentFixture(overrides = {}) {
  const f = await serverFixture();
  const rawPolicy = {label: 'Synthetic AI payment allowance', accountId: f.account.id, chainId: '31337', asset: 'native',
    recipients: [TO], mode: 'manual', expiresAt: f.state.now + 86400000,
    limits: {perTransferAtomic: '100', rolling24hAtomic: '200', lifetimeAtomic: '300', perTxFeeWei: '100000000000000', rolling24hFeeWei: '1000000000000000', lifetimeFeeWei: '2000000000000000', maxTransfers: 10, minIntervalMs: 0}, ...overrides};
  const create = async (policy = rawPolicy) => {
    const d = await f.call('agents/prepare', {policy});
    const grant = await f.call('agents/create', {draftId: d.draftId, digest: d.digest, confirmation: policy.mode === 'auto' ? AUTO_CONFIRMATION : MANUAL_CONFIRMATION});
    return {...grant, draft: d};
  };
  const agentHttp = (route, body = {}, token = grant.token, headers = {}) => fetch(f.start.origin + '/agent/v1/' + route, {
    method: 'POST', headers: {'content-type': 'application/json', 'x-realdex-agent': '1', authorization: 'Bearer ' + token, ...headers}, body: JSON.stringify(body),
  });
  const agent = async (route, body = {}, token) => { const r = await agentHttp(route, body, token); const b = await r.json(); if (!r.ok) throw Error(b.error); return b; };
  let grant;
  try { grant = await create(); } catch (e) { await f.close(); throw e; }
  return {...f, rawPolicy, grant, create, agent, agentHttp};
}
export const payment = (key = 'invoice-001', amountAtomic = '50') => ({idempotencyKey: key, recipient: TO, amountAtomic});
