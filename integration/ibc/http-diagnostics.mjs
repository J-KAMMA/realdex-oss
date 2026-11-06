/** Bounded, allowlisted diagnostics for the disposable IBC TEST forwarder only.
 * No raw URLs, query values, headers, body, account IDs, keys or exception text.
 * Records observations, NOT proof of the root cause of a previous failure.
 */
import {createHash} from 'node:crypto';
const TYPES = new Set(['rpc', 'rest']);
const RPC = new Set(['status', 'block', 'commit', 'validators', 'abci_query', 'tx', 'tx_search']);
const REST = [
  ['/cosmos/auth/v1beta1/accounts/', 'account'],
  ['/cosmos/bank/v1beta1/spendable_balances/', 'spendable-balance'],
  ['/cosmos/bank/v1beta1/balances/', 'bank-balance'],
  ['/cosmos/tx/v1beta1/simulate', 'simulation'],
  ['/cosmos/tx/v1beta1/txs', 'transaction'],
  ['/ibc/core/channel/v1/channels/', 'channel'],
  ['/ibc/core/connection/v1/connections/', 'connection'],
  ['/ibc/core/client/v1/client_states/', 'client-state'],
  ['/ibc/core/client/v1/consensus_states/', 'consensus-state'],
  ['/ibc/core/channel/v1/packet_', 'packet'],
  ['/ibc/apps/transfer/v1/denom_', 'denom-trace']
];
const hash = b => createHash('sha256').update(b).digest('hex');
const height = x => x === undefined || x === null ? null :
  typeof x === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(x) && BigInt(x) < 1n << 64n ? x : 'invalid';
function json(value) {
  if (typeof value !== 'string' || value.length > 65536) return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}
function route(type, path, requestBody) {
  if (type === 'rpc') {
    const method = json(requestBody)?.method;
    return RPC.has(method) ? method : 'other-rpc';
  }
  if (typeof path !== 'string' || path.length > 8192 || !path.startsWith('/')) return 'other-rest';
  return REST.find(([prefix]) => path.split('?')[0].startsWith(prefix))?.[1] ?? 'other-rest';
}
function reportedCondition(parsed) {
  if (!parsed) return {nodeCode: null, nodeCondition: 'unclassified'};
  const code = Number.isSafeInteger(parsed.code) && parsed.code >= 0 && parsed.code <= 16 ? parsed.code : null;
  const message = typeof parsed.message === 'string' && parsed.message.length <= 4096 ? parsed.message : '';
  // Intentionally a small set of node-reported conditions, not a heuristic retry policy.
  const unavailable = /failed to load state at height|version [0-9]+ does not exist|height [0-9]+ must be less than or equal to|cannot query with height [0-9]+.*(greater|latest)/i.test(message);
  return {nodeCode: code, nodeCondition: unavailable ? 'height-unavailable-reported' : 'unclassified'};
}
export function createHttpDiagnostics({capacity = 64} = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 128) throw Error('IBC_DIAGNOSTIC_CAPACITY');
  let total = 0, failures = 0, lastFailure = null;
  const recent = [];
  function record(input) {
    if (!input || !TYPES.has(input.type) || ![0, 1].includes(input.peer)) throw Error('IBC_DIAGNOSTIC_INPUT');
    const status = Number.isSafeInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : null;
    const body = typeof input.responseBody === 'string' ? input.responseBody : null;
    const parsed = json(body);
    const fault = input.transportFailure === true || status === null || status < 200 || status >= 300;
    const item = {
      sequence: ++total, peer: input.peer, type: input.type,
      method: ['GET', 'POST'].includes(input.method) ? input.method : 'other',
      route: route(input.type, input.path, input.requestBody),
      requestHeight: height(input.requestHeight), responseHeight: height(input.responseHeight),
      gatewayResponseHeight: height(input.gatewayResponseHeight),
      status, transportFailure: input.transportFailure === true,
      responseBytes: body === null ? null : Buffer.byteLength(body),
      // Even hashing is bounded; no oversized body is retained by the recorder.
      responseSha256: body !== null && Buffer.byteLength(body) <= 1048576 ? hash(body) : null,
      ...reportedCondition(parsed),
      // Safe shape fingerprints distinguish metadata drift from application-state drift.
      proofHeight: height(parsed?.proof_height?.revision_height),
      gasUsed: height(parsed?.gas_info?.gas_used),
      gasWanted: height(parsed?.gas_info?.gas_wanted),
      simulationRequestSha256: input.type === 'rest' && route(input.type,input.path,input.requestBody) === 'simulation' && typeof input.requestBody === 'string' && Buffer.byteLength(input.requestBody) <= 65536 ? hash(input.requestBody) : null,
      simulationResultSha256: parsed?.gas_info && parsed?.result && typeof parsed.result === 'object' && !Array.isArray(parsed.result) ? hash(JSON.stringify(parsed.result)) : null,
      stateDigests: Object.fromEntries(['channel','connection','client_state','balance','gas_info'].filter(k=>parsed?.[k]!==undefined).map(k=>[k,hash(JSON.stringify(parsed[k]))]))
    };
    recent.push(item); if (recent.length > capacity) recent.shift();
    if (fault) { failures++; lastFailure = item; }
  }
  return Object.freeze({record, snapshot() {
    return structuredClone({schema: 'realdex.ibc-http-diagnostics.v1', capacity, total, failures,
      discarded: Math.max(0, total - capacity), lastFailure, recent, rawPayloadsIncluded: false,
      historicalRootCauseProven: false, retriesPerformedByRecorder: 0});
  }});
}
