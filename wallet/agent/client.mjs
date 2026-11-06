/** Node-only client. Credentials are a bounded agent capability, NOT a wallet/private key. */
import {need, safeError, shape} from '../lib/guard.mjs';
export class AgentWalletClient {
  constructor({url = 'http://127.0.0.1:8790', token, timeoutMs = 30000, fetchImpl = globalThis.fetch} = {}) {
    let u; try { u = new URL(url); } catch { throw Error('AGENT_CLIENT_URL_INVALID'); }
    need(u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.origin === url && !u.username && !u.password && !u.search && !u.hash, 'AGENT_CLIENT_LOOPBACK_REQUIRED');
    need(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'AGENT_CLIENT_TOKEN_REQUIRED');
    need(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000, 'AGENT_CLIENT_TIMEOUT_INVALID');
    this.url = url; this.token = token; this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl;
  }
  async call(route, input = {}) {
    need(['status', 'balance', 'preview', 'transfer', 'result', 'history'].includes(route), 'AGENT_METHOD_DENIED');
    const payload = JSON.stringify(input); need(Buffer.byteLength(payload) <= 16384, 'AGENT_CLIENT_REQUEST_LIMIT');
    let response;
    try {
      response = await this.fetchImpl(this.url + '/agent/v1/' + route, {method: 'POST', redirect: 'error', credentials: 'omit',
        headers: {'content-type': 'application/json', 'x-realdex-agent': '1', authorization: 'Bearer ' + this.token},
        body: payload, signal: AbortSignal.timeout(this.timeoutMs)});
    } catch { throw Error(route === 'transfer' ? 'AGENT_RESULT_UNCERTAIN_CHECK_SAME_KEY' : 'AGENT_CLIENT_TRANSPORT_ERROR'); }
    let value;
    try {
      const reader = response.body?.getReader(); need(reader, 'AGENT_CLIENT_EMPTY_RESPONSE');
      const parts = []; let size = 0;
      try { for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.length; need(size <= 524288, 'AGENT_CLIENT_RESPONSE_LIMIT'); parts.push(Buffer.from(value)); } }
      finally { await reader.cancel().catch(() => {}); }
      value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch { throw Error(route === 'transfer' ? 'AGENT_RESULT_UNCERTAIN_CHECK_SAME_KEY' : 'AGENT_CLIENT_RESPONSE_INVALID'); }
    if (!response.ok || value?.error && !value?.requestId) throw Error(safeError(new Error(value?.error)));
    return value;
  }
  status() { return this.call('status'); }
  balance() { return this.call('balance'); }
  preview(input) { return this.call('preview', input); }
  transfer(input) { return this.call('transfer', input); }
  result(idempotencyKey, {refresh = false} = {}) { return this.call('result', {idempotencyKey, refresh}); }
  history() { return this.call('history'); }
  destroy() { this.token = ''; }
}
