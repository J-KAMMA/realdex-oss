import {shape, need, safeError} from '../lib/guard.mjs';
const empty = {type: 'object', properties: {}, additionalProperties: false};
const annotations = (readOnlyHint, destructiveHint = false, idempotentHint = true) => ({readOnlyHint, destructiveHint, idempotentHint, openWorldHint: true});
export const AGENT_TOOLS = Object.freeze([
  {name: 'realdex_agent_status', title: 'Read granted wallet permissions', description: 'Read this agent\'s account, recipient allowlist, token, chain, immutable limits, usage and expiry. Cannot unlock or expand authority.', inputSchema: empty, annotations: annotations(true)},
  {name: 'realdex_agent_balance', title: 'Read permitted balance', description: 'Observe only the granted asset and gas balance using the owner-configured RPCs. This is not a certified balance or a price feed.', inputSchema: empty, annotations: annotations(true)},
  {name: 'realdex_agent_preview', title: 'Preview a permitted payment without signing', description: 'Read-only preflight: checks the recipient, asset, balance, gas cap and remaining allowance. Does not reserve budget, create an approval, sign or send. Use the same stable idempotencyKey later; an existing request returns its saved result, not a new payment.',
    inputSchema: {type: 'object', properties: {idempotencyKey: {type: 'string', pattern: '^[A-Za-z0-9._:-]{1,80}$'}, recipient: {type: 'string', pattern: '^0x[0-9a-fA-F]{40}$'}, amountAtomic: {type: 'string', pattern: '^[1-9][0-9]{0,77}$'}, note: {type: 'string', minLength: 1, maxLength: 160}}, required: ['idempotencyKey', 'recipient', 'amountAtomic'], additionalProperties: false}, annotations: annotations(true)},
  {name: 'realdex_agent_transfer', title: 'Request a bounded transfer', description: 'SPENDS TEST FUNDS when the owner explicitly enabled auto mode; otherwise waits for owner approval. Amount is a decimal STRING in smallest token units, never a fiat value. Use one stable idempotencyKey for the same logical payment. A timeout is NOT failure: query result with the same key. Never change the key to retry an uncertain payment. No swaps, approvals, bridges or arbitrary calls.',
    inputSchema: {type: 'object', properties: {idempotencyKey: {type: 'string', pattern: '^[A-Za-z0-9._:-]{1,80}$'}, recipient: {type: 'string', pattern: '^0x[0-9a-fA-F]{40}$'}, amountAtomic: {type: 'string', pattern: '^[1-9][0-9]{0,77}$'}, note: {type: 'string', minLength: 1, maxLength: 160}}, required: ['idempotencyKey', 'recipient', 'amountAtomic'], additionalProperties: false}, annotations: annotations(false, true)},
  {name: 'realdex_agent_result', title: 'Read payment result by original key', description: 'Read the durable state of a prior request using its original idempotencyKey. Optional refresh rechecks receipts including previously successful ones, binds transaction content and canonical blocks, and reports confirmation depth/finality tags as RPC observations only. A disappeared receipt clears current success. Does NOT rebroadcast. broadcast-unknown and signed are not failure; their budgets remain charged.', inputSchema: {type: 'object', properties: {idempotencyKey: {type: 'string', pattern: '^[A-Za-z0-9._:-]{1,80}$'}, refresh: {type: 'boolean', default: false}}, required: ['idempotencyKey'], additionalProperties: false}, annotations: annotations(true)},
  {name: 'realdex_agent_history', title: 'Read this agent\'s payment history', description: 'Read only payments under this grant. Does not expose private keys, raw signed transactions, unrelated accounts or other agents\' histories.', inputSchema: empty, annotations: annotations(true)},
]);
export async function callAgentTool(client, name, args) {
  if (!AGENT_TOOLS.some(t => t.name === name)) { const e = Error('UNKNOWN_TOOL'); e.rpcCode = -32602; throw e; }
  try {
    let result;
    if (name === 'realdex_agent_transfer' || name === 'realdex_agent_preview') { shape(args, ['idempotencyKey', 'recipient', 'amountAtomic'], ['note']); result = await client[name === 'realdex_agent_preview' ? 'preview' : 'transfer'](args); }
    else if (name === 'realdex_agent_result') { shape(args, ['idempotencyKey'], ['refresh']); if (args.refresh !== undefined) need(typeof args.refresh === 'boolean', 'AGENT_REFRESH_INVALID'); result = await client.result(args.idempotencyKey, {refresh: args.refresh ?? false}); }
    else { shape(args, []); result = await client[name.replace('realdex_agent_', '')](); }
    const isError = result?.state === 'failed-before-sign' || result?.state === 'cancelled';
    return {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result, isError};
  } catch (e) {
    const error = safeError(e);
    return {content: [{type: 'text', text: JSON.stringify({error, automaticRetry: false, instruction: 'Inspect the original idempotency key after uncertain outcomes; do not create a replacement payment.'})}], isError: true};
  }
}
export class AgentMcpSession {
  constructor(client) { this.client = client; this.initialized = false; }
  async dispatch(message) {
    let id = null;
    try {
      need(message && typeof message === 'object' && !Array.isArray(message) && message.jsonrpc === '2.0', 'INVALID_REQUEST');
      const hasId = Object.hasOwn(message, 'id');
      if (hasId) { need(typeof message.id === 'string' && message.id.length <= 128 || Number.isSafeInteger(message.id), 'INVALID_REQUEST'); id = message.id; }
      need(typeof message.method === 'string' && message.method.length <= 128, 'INVALID_REQUEST');
      if (!hasId) return null; // No response to notifications, no state-changing tool notifications.
      if (message.method === 'initialize') {
        need(!this.initialized, 'ALREADY_INITIALIZED');
        const params = message.params; need(params && typeof params.protocolVersion === 'string', 'INVALID_PARAMS');
        this.initialized = true;
        return {jsonrpc: '2.0', id, result: {protocolVersion: ['2025-11-25', '2025-06-18'].includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25', capabilities: {tools: {}}, serverInfo: {name: 'realdex-bounded-agent-wallet', version: '0.9.0-dev'}, instructions: 'Manual approval by default. Only the wallet owner can enable limited auto mode. Never put wallet passwords, UI capabilities or private keys in prompts.'}};
      }
      need(this.initialized, 'INITIALIZATION_REQUIRED');
      if (message.method === 'ping') return {jsonrpc: '2.0', id, result: {}};
      if (message.method === 'tools/list') return {jsonrpc: '2.0', id, result: {tools: AGENT_TOOLS}};
      if (message.method === 'tools/call') {
        shape(message.params, ['name'], ['arguments', '_meta']);
        const result = await callAgentTool(this.client, message.params.name, message.params.arguments ?? {});
        return {jsonrpc: '2.0', id, result};
      }
      return {jsonrpc: '2.0', id, error: {code: -32601, message: 'METHOD_NOT_FOUND'}};
    } catch (e) { return {jsonrpc: '2.0', id, error: {code: e.rpcCode ?? (e.message === 'INVALID_REQUEST' ? -32600 : -32602), message: safeError(e)}}; }
  }
}
