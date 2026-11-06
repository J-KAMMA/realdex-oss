import {parseSignedEvmTransaction, abiWord, abiAddress} from './transactions.mjs';
/** Deterministic, deny-by-default transfer policy. This is LOCAL, not on-chain enforcement. */
import {need, shape, text, uint, canonical, clone} from './guard.mjs';
import {recipientAddress, transferAsset} from './transfers.mjs';
import {sha256} from './keys.mjs';
export const DAY_MS = 86_400_000;
export const POLICY_SCHEMA = 'realdex.agent-policy.v1';
export const AUTO_CONFIRMATION = 'ALLOW BOUNDED AUTOMATION';
export const MANUAL_CONFIRMATION = 'REQUIRE MY APPROVAL';
export const LIMIT_FIELDS = ['perTransferAtomic', 'rolling24hAtomic', 'lifetimeAtomic', 'perTxFeeWei', 'rolling24hFeeWei', 'lifetimeFeeWei', 'maxTransfers', 'minIntervalMs'];
const COUNTED = new Set(['reserved', 'awaiting-approval', 'signed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const hashObject = value => sha256(Buffer.from(canonical(value))).toString('hex');
export const networkFingerprint = network => hashObject(network);
export const tokenHash = token => sha256(Buffer.from(token)).toString('hex');
function millis(n) { need(Number.isSafeInteger(n) && n >= 0, 'AGENT_TIMESTAMP_INVALID'); return n; }
export function limits(raw) {
  shape(raw, LIMIT_FIELDS);
  const out = {};
  for (const k of LIMIT_FIELDS.slice(0, 6)) { out[k] = String(uint(raw[k])); need(BigInt(out[k]) > 0n, 'AGENT_ZERO_LIMIT'); }
  need(BigInt(out.perTransferAtomic) <= BigInt(out.rolling24hAtomic) && BigInt(out.rolling24hAtomic) <= BigInt(out.lifetimeAtomic), 'AGENT_AMOUNT_LIMIT_ORDER');
  need(BigInt(out.perTxFeeWei) <= BigInt(out.rolling24hFeeWei) && BigInt(out.rolling24hFeeWei) <= BigInt(out.lifetimeFeeWei), 'AGENT_FEE_LIMIT_ORDER');
  need(Number.isSafeInteger(raw.maxTransfers) && raw.maxTransfers >= 1 && raw.maxTransfers <= 512, 'AGENT_TRANSFER_COUNT_INVALID');
  need(Number.isSafeInteger(raw.minIntervalMs) && raw.minIntervalMs >= 0 && raw.minIntervalMs <= DAY_MS, 'AGENT_INTERVAL_INVALID');
  return {...out, maxTransfers: raw.maxTransfers, minIntervalMs: raw.minIntervalMs};
}
export function normalizePolicy(raw, network, account, now, id) {
  shape(raw, ['label', 'accountId', 'chainId', 'asset', 'recipients', 'mode', 'expiresAt', 'limits']);
  text(raw.label, 80); need(UUID.test(id), 'AGENT_ID_INVALID');
  need(raw.accountId === account.id && account.kind === 'local' && account.family === 'evm', 'EVM_LOCAL_ACCOUNT_REQUIRED');
  need(raw.chainId === network.chainId, 'AGENT_NETWORK_MISMATCH');
  need(['manual', 'auto'].includes(raw.mode), 'AGENT_MODE_INVALID');
  need(network.broadcastEnabled, 'BROADCAST_DISABLED');
  millis(now); millis(raw.expiresAt); need(raw.expiresAt > now && raw.expiresAt <= now + 7 * DAY_MS, 'AGENT_EXPIRY_INVALID');
  need(Array.isArray(raw.recipients) && raw.recipients.length > 0 && raw.recipients.length <= 16, 'AGENT_RECIPIENTS_REQUIRED');
  const recipients = raw.recipients.map(recipientAddress).sort();
  need(new Set(recipients).size === recipients.length && !recipients.includes(account.address), 'AGENT_RECIPIENTS_INVALID');
  const asset = transferAsset(network, raw.asset), l = limits(raw.limits);
  need(BigInt(l.perTxFeeWei) <= BigInt(network.maxFeeWei), 'AGENT_FEE_EXCEEDS_NETWORK_CAP');
  return {schema: POLICY_SCHEMA, id, label: raw.label, accountId: account.id, chainId: network.chainId,
    genesisHash: network.genesisHash, networkFingerprint: networkFingerprint(network), ...asset,
    recipients, mode: raw.mode, limits: l, createdAt: now, expiresAt: raw.expiresAt,
    status: 'active', tokenHash: null, lastSeenAt: now};
}
export function normalizeAgentTransfer(raw) {
  shape(raw, ['idempotencyKey', 'recipient', 'amountAtomic'], ['note']);
  need(typeof raw.idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(raw.idempotencyKey), 'AGENT_IDEMPOTENCY_KEY_INVALID');
  const recipient = recipientAddress(raw.recipient), amountAtomic = String(uint(raw.amountAtomic));
  need(BigInt(amountAtomic) > 0n, 'ZERO_TRANSFER');
  if (raw.note !== undefined) text(raw.note, 160);
  return {idempotencyKey: raw.idempotencyKey, recipient, amountAtomic, note: raw.note ?? null};
}
export function policyUsage(policy, requests, now) {
  millis(now);
  let lifetimeAtomic = 0n, rolling24hAtomic = 0n, lifetimeFeeWei = 0n, rolling24hFeeWei = 0n, count = 0, lastReservedAt = null;
  for (const r of requests.filter(r => r.policyId === policy.id && COUNTED.has(r.state))) {
    const amount = BigInt(r.amountAtomic), fee = BigInt(r.feeReservedWei);
    lifetimeAtomic += amount; lifetimeFeeWei += fee; count++;
    lastReservedAt = Math.max(lastReservedAt ?? 0, r.reservedAt);
    // Pending reservations never age out: they may still produce a signature until cancelled.
    if (r.state !== 'signed' || (r.signedAt ?? r.reservedAt) > now - DAY_MS) { rolling24hAtomic += amount; rolling24hFeeWei += fee; }
  }
  return {lifetimeAtomic: String(lifetimeAtomic), rolling24hAtomic: String(rolling24hAtomic), lifetimeFeeWei: String(lifetimeFeeWei), rolling24hFeeWei: String(rolling24hFeeWei), count, lastReservedAt};
}
export function assertPolicyActive(policy, network, now) {
  need(policy.status === 'active', 'AGENT_POLICY_REVOKED');
  need(now >= policy.lastSeenAt && now >= policy.createdAt, 'AGENT_CLOCK_ROLLBACK');
  need(now < policy.expiresAt, 'AGENT_POLICY_EXPIRED');
  need(policy.chainId === network.chainId && policy.genesisHash === network.genesisHash && policy.networkFingerprint === networkFingerprint(network), 'AGENT_NETWORK_POLICY_CHANGED');
}
export function assertCanReserve(policy, requests, input, now) {
  need(policy.recipients.includes(input.recipient), 'AGENT_RECIPIENT_DENIED');
  const amount = BigInt(input.amountAtomic), l = policy.limits, usage = policyUsage(policy, requests, now), fee = BigInt(l.perTxFeeWei);
  need(amount <= BigInt(l.perTransferAtomic), 'AGENT_PER_TRANSFER_LIMIT');
  need(BigInt(usage.lifetimeAtomic) + amount <= BigInt(l.lifetimeAtomic), 'AGENT_LIFETIME_LIMIT');
  need(BigInt(usage.rolling24hAtomic) + amount <= BigInt(l.rolling24hAtomic), 'AGENT_ROLLING_LIMIT');
  need(BigInt(usage.lifetimeFeeWei) + fee <= BigInt(l.lifetimeFeeWei), 'AGENT_LIFETIME_FEE_LIMIT');
  need(BigInt(usage.rolling24hFeeWei) + fee <= BigInt(l.rolling24hFeeWei), 'AGENT_ROLLING_FEE_LIMIT');
  need(usage.count < l.maxTransfers, 'AGENT_TRANSFER_COUNT_LIMIT');
  need(usage.lastReservedAt === null || now - usage.lastReservedAt >= l.minIntervalMs, 'AGENT_MIN_INTERVAL');
  return usage;
}
export function assertTransferIntent(policy, claim, intent, now) {
  need(claim.policyId === policy.id && claim.state === 'awaiting-approval', 'AGENT_REQUEST_NOT_READY');
  need(now < claim.expiresAt && now < intent.expiresAt, 'AGENT_REQUEST_EXPIRED');
  need(claim.intentId === intent.id && policy.accountId === intent.accountId && policy.chainId === intent.networkId, 'AGENT_INTENT_BINDING');
  const s = intent.summary;
  need(s.operation === (policy.asset === 'native' ? 'native-transfer' : 'erc20-transfer'), 'AGENT_OPERATION_DENIED');
  need(s.recipient === claim.recipient && s.amountAtomic === claim.amountAtomic && s.assetMoves.length === 1, 'AGENT_INTENT_BINDING');
  const move = s.assetMoves[0];
  need(move.address === policy.address && move.amountAtomic === claim.amountAtomic && move.decimals === policy.decimals, 'AGENT_ASSET_BINDING');
  need(BigInt(s.executionFeeCapWei) <= BigInt(claim.feeReservedWei) && BigInt(s.executionFeeCapWei) <= BigInt(policy.limits.perTxFeeWei), 'AGENT_PER_TX_FEE_LIMIT');
}
export function publicPolicy(policy, requests, now, activated) {
  const {tokenHash: _secretHash, ...out} = policy;
  return {...clone(out), activated, enforcement: 'local-signer-policy-not-onchain', usage: policyUsage(policy, requests, now),
    needsLocalActivation: !activated, limitsIncludeAllSignedTransactions: true, automaticRetry: false};
}
/** Validate encrypted agent state on load. Older v0.7 vaults have neither optional array. */
export function validateAgentData(data) {
  if (data.agentPolicies === undefined && data.agentRequests === undefined) return;
  need(Array.isArray(data.agentPolicies) && data.agentPolicies.length <= 32 && Array.isArray(data.agentRequests) && data.agentRequests.length <= 512, 'AGENT_STORAGE_LIMIT');
  const ids = new Set();
  for (const p of data.agentPolicies) {
    shape(p, ['schema', 'id', 'label', 'accountId', 'chainId', 'genesisHash', 'networkFingerprint', 'asset', 'address', 'symbol', 'decimals', 'runtimeHash', 'recipients', 'mode', 'limits', 'createdAt', 'expiresAt', 'status', 'tokenHash', 'lastSeenAt']);
    need(p.schema === POLICY_SCHEMA && UUID.test(p.id) && !ids.has(p.id), 'AGENT_ID_INVALID'); ids.add(p.id); text(p.label);
    need(data.accounts.some(a => a.id === p.accountId && a.family === 'evm' && a.kind === 'local'), 'AGENT_ACCOUNT_INVALID');
    need(uint(p.chainId) > 0n && /^0x[0-9a-f]{64}$/.test(p.genesisHash) && /^[0-9a-f]{64}$/.test(p.networkFingerprint), 'AGENT_NETWORK_INVALID');
    need(['manual', 'auto'].includes(p.mode) && ['active', 'revoked'].includes(p.status), 'AGENT_POLICY_INVALID');
    need(p.tokenHash === null || /^[0-9a-f]{64}$/.test(p.tokenHash), 'AGENT_TOKEN_HASH_INVALID');
    limits(p.limits); text(p.symbol, 16); need(Number.isInteger(p.decimals) && p.decimals >= 0 && p.decimals <= 36, 'TOKEN_DECIMALS_INVALID');
    need(p.asset === 'native' ? p.address === null && p.runtimeHash === null && p.decimals === 18 : recipientAddress(p.asset) === p.address && /^0x[0-9a-f]{64}$/.test(p.runtimeHash), 'AGENT_ASSET_INVALID');
    need(Array.isArray(p.recipients) && p.recipients.length > 0 && p.recipients.length <= 16 && new Set(p.recipients).size === p.recipients.length, 'AGENT_RECIPIENTS_INVALID');
    p.recipients.forEach(a => need(recipientAddress(a) === a, 'AGENT_RECIPIENTS_INVALID'));
    [p.createdAt, p.expiresAt, p.lastSeenAt].forEach(millis);
    need(p.createdAt < p.expiresAt && p.expiresAt <= p.createdAt + 7 * DAY_MS && p.lastSeenAt >= p.createdAt, 'AGENT_TIMESTAMP_INVALID');
  }
  const requestIds = new Set(), keys = new Set();
  for (const r of data.agentRequests) {
    shape(r, ['id', 'policyId', 'idempotencyKey', 'requestHash', 'recipient', 'amountAtomic', 'note', 'createdAt', 'reservedAt', 'expiresAt', 'signedAt', 'state', 'feeReservedWei', 'intentId', 'recordId', 'error']);
    need(UUID.test(r.id) && !requestIds.has(r.id) && ids.has(r.policyId), 'AGENT_REQUEST_INVALID'); requestIds.add(r.id);
    const input = normalizeAgentTransfer({idempotencyKey: r.idempotencyKey, recipient: r.recipient, amountAtomic: r.amountAtomic, ...(r.note === null ? {} : {note: r.note})});
    const key = r.policyId + ':' + r.idempotencyKey; need(!keys.has(key) && hashObject(input) === r.requestHash, 'AGENT_IDEMPOTENCY_INVALID'); keys.add(key);
    const p = data.agentPolicies.find(p => p.id === r.policyId); need(p.recipients.includes(r.recipient), 'AGENT_RECIPIENT_DENIED');
    [r.createdAt, r.reservedAt, r.expiresAt].forEach(millis); need(r.createdAt === r.reservedAt && r.createdAt >= p.createdAt && r.expiresAt > r.createdAt && r.expiresAt <= p.expiresAt && r.expiresAt <= r.createdAt + 90000, 'AGENT_TIMESTAMP_INVALID');
    need(['reserved', 'awaiting-approval', 'signed', 'cancelled', 'failed-before-sign'].includes(r.state), 'AGENT_STATE_INVALID');
    uint(r.feeReservedWei); need(BigInt(r.amountAtomic) <= BigInt(p.limits.perTransferAtomic) && BigInt(r.feeReservedWei) <= BigInt(p.limits.perTxFeeWei), 'AGENT_RESERVATION_INVALID');
    need(r.error === null || typeof r.error === 'string' && /^[A-Z0-9_]{1,90}$/.test(r.error), 'AGENT_ERROR_INVALID');
    need(r.intentId === null || /^[0-9a-f]{64}$/.test(r.intentId), 'AGENT_INTENT_INVALID');
    if (r.state === 'signed') {
      millis(r.signedAt); need(r.signedAt >= r.reservedAt, 'AGENT_TIMESTAMP_INVALID');
      const record = data.journal.find(j => j.id === r.recordId);
      need(record && record.agent?.policyId === p.id && record.agent?.requestId === r.id && record.intentId === r.intentId && record.accountId === p.accountId && record.summary.recipient === r.recipient && record.summary.amountAtomic === r.amountAtomic && record.summary.executionFeeCapWei === r.feeReservedWei, 'AGENT_JOURNAL_BINDING_INVALID');
      need(record.nonceKey === `evm:${p.chainId}:${p.genesisHash}:${record.summary.from}:${record.summary.nonce}`, 'AGENT_JOURNAL_BINDING_INVALID');
      const decoded = parseSignedEvmTransaction(record.signed.rawTransaction), tx = decoded.transaction;
      need(tx.chainId === p.chainId && decoded.from === record.summary.from && tx.nonce === record.summary.nonce, 'AGENT_JOURNAL_BINDING_INVALID');
      const expectedData = p.asset === 'native' ? '0x' : '0xa9059cbb' + abiAddress(r.recipient) + abiWord(r.amountAtomic);
      need(tx.to === (p.address ?? r.recipient) && tx.value === (p.asset === 'native' ? r.amountAtomic : '0') && tx.data === expectedData, 'AGENT_SIGNED_TRANSFER_MISMATCH');
      need(BigInt(tx.gasLimit) * BigInt(tx.type === 2 ? tx.maxFeePerGas : tx.gasPrice) === BigInt(r.feeReservedWei), 'AGENT_SIGNED_FEE_MISMATCH');

    } else need(r.recordId === null && r.signedAt === null, 'AGENT_UNSIGNED_RECORD_INVALID');
  }
  for (const j of data.journal.filter(j => j.agent)) {
    shape(j.agent, ['policyId', 'requestId']);
    need(data.agentRequests.some(r => r.id === j.agent.requestId && r.policyId === j.agent.policyId && r.recordId === j.id && r.state === 'signed'), 'AGENT_JOURNAL_BINDING_INVALID');
  }
}
