import {smartReceiptObservation} from '../smart-account/receipt.mjs';
/**
 * Reorg-aware EVM receipt observations. RPC agreement is NOT a consensus proof.
 * This module never submits transactions and never releases agent allowances.
 */
import {need, shape, q, quantity, hex} from './guard.mjs';
import {address} from '../../node/verified/keccak.mjs';
import {parseSignedEvmTransaction} from './transactions.mjs';
import {transferReceiptObservation} from './transfer-receipts.mjs';

export const DEFAULT_CONFIRMATION_POLICY = Object.freeze({minConfirmations: 12, finalityTag: 'none'});
export function confirmationPolicy(value = DEFAULT_CONFIRMATION_POLICY) {
  shape(value, ['minConfirmations', 'finalityTag']);
  need(Number.isSafeInteger(value.minConfirmations) && value.minConfirmations >= 1 && value.minConfirmations <= 4096, 'CONFIRMATION_DEPTH_INVALID');
  need(['none', 'safe', 'finalized'].includes(value.finalityTag), 'FINALITY_TAG_INVALID');
  return {minConfirmations: value.minConfirmations, finalityTag: value.finalityTag};
}
function hash(value) { hex(value, 32); return value.toLowerCase(); }
function sameQuantity(a, b) { return q(a) === q(b); }
function requireBlock(block, number, expectedHash, error = 'RECEIPT_BLOCK_MISMATCH') {
  need(block && typeof block === 'object' && sameQuantity(block.number, number) && hash(block.hash) === hash(expectedHash), error);
  return block;
}
export function assertJournalBinding(record, network) {
  const signed = parseSignedEvmTransaction(record.signed.rawTransaction), t = signed.transaction;
  need(record.family === 'evm' && record.summary.chainId === network.chainId && t.chainId === network.chainId, 'RECONCILIATION_NETWORK_MISMATCH');
  need(record.nonceKey === `evm:${network.chainId}:${network.genesisHash}:${signed.from}:${t.nonce}`, 'JOURNAL_GENESIS_BINDING_MISMATCH');
  need(signed.transactionHash === record.signed.transactionHash && signed.from === record.summary.from &&
    t.to === record.summary.to && t.nonce === record.summary.nonce, 'SIGNED_JOURNAL_BINDING_MISMATCH');
  return signed;
}
/** Bind the node's transaction to locally authenticated signed bytes, not just a receipt label. */
export function assertTransactionObservation(transaction, receipt, signed) {
  const t = signed.transaction;
  need(transaction && typeof transaction === 'object', 'RECEIPT_TRANSACTION_UNAVAILABLE');
  need(hash(transaction.hash) === signed.transactionHash && address(transaction.from) === signed.from &&
    address(transaction.to) === t.to && hash(transaction.blockHash) === hash(receipt.blockHash) &&
    sameQuantity(transaction.blockNumber, receipt.blockNumber) && sameQuantity(transaction.transactionIndex, receipt.transactionIndex), 'RECEIPT_TRANSACTION_BINDING_MISMATCH');
  need(q(transaction.nonce) === BigInt(t.nonce) && q(transaction.value) === BigInt(t.value) &&
    q(transaction.gas) === BigInt(t.gasLimit) && q(transaction.type) === BigInt(t.type) &&
    q(transaction.chainId) === BigInt(t.chainId) && typeof transaction.input === 'string' &&
    transaction.input.toLowerCase() === t.data, 'RECEIPT_TRANSACTION_CONTENT_MISMATCH');
  if (t.type === 2) {
    need(q(transaction.maxFeePerGas) === BigInt(t.maxFeePerGas) && q(transaction.maxPriorityFeePerGas) === BigInt(t.maxPriorityFeePerGas), 'RECEIPT_TRANSACTION_FEE_MISMATCH');
    need(Array.isArray(transaction.accessList) && transaction.accessList.length === 0, 'RECEIPT_TRANSACTION_ACCESS_LIST_MISMATCH');
  } else need(q(transaction.gasPrice) === BigInt(t.gasPrice), 'RECEIPT_TRANSACTION_FEE_MISMATCH');
}
function previousReceipt(record) {
  const r = record.report;
  if (!r?.blockHash || !r.blockNumber) return r?.lastKnownReceipt ?? null;
  return {blockHash: r.blockHash, blockNumber: r.blockNumber,
    successful: r.transactionReportedSuccessful === true, observedAt: r.observedAt ?? null};
}
export function uncertainObservation(record, now, reason, extra = {}) {
  return {schema: 'realdex.settlement-observation.v1', observedAt: now, observation: reason,
    transactionReportedSuccessful: null, policySatisfied: false, confirmations: '0',
    finalityVerified: false, actualBalanceChangeVerified: false, matchingTransferEventObserved: null,
    observedEventAmountAtomic: null, deliveryObserved: false, transactionContentMatched: false,
    automaticRetry: false, lastKnownReceipt: previousReceipt(record), ...extra};
}
function assertReceipt(receipt, signed) {
  need(receipt && typeof receipt === 'object' && hash(receipt.transactionHash) === signed.transactionHash &&
    address(receipt.from) === signed.from && address(receipt.to) === signed.transaction.to, 'RECEIPT_BINDING_MISMATCH');
  hash(receipt.blockHash); q(receipt.blockNumber); q(receipt.transactionIndex);
  need(receipt.status === '0x0' || receipt.status === '0x1', 'RECEIPT_STATUS_INVALID');
  const gasUsed = q(receipt.gasUsed), price = q(receipt.effectiveGasPrice);
  need(gasUsed > 0n && gasUsed <= BigInt(signed.transaction.gasLimit), 'RECEIPT_GAS_USAGE_INVALID');
  const feeCap = BigInt(signed.transaction.type === 2 ? signed.transaction.maxFeePerGas : signed.transaction.gasPrice);
  need(price <= feeCap, 'RECEIPT_FEE_EXCEEDS_SIGNED_CAP');
  need(Array.isArray(receipt.logs) && receipt.logs.length <= 512, 'RECEIPT_LOG_LIMIT');
  const seen = new Set();
  for (const log of receipt.logs) {
    need(log && log.removed === false && hash(log.transactionHash) === signed.transactionHash &&
      hash(log.blockHash) === hash(receipt.blockHash) && sameQuantity(log.blockNumber, receipt.blockNumber) &&
      sameQuantity(log.transactionIndex, receipt.transactionIndex), 'RECEIPT_LOG_BINDING_MISMATCH');
    const index = String(q(log.logIndex)); need(!seen.has(index), 'RECEIPT_DUPLICATE_LOG'); seen.add(index);
    address(log.address); hex(log.data); need(Array.isArray(log.topics) && log.topics.length <= 4, 'RECEIPT_LOG_TOPICS_INVALID');
    log.topics.forEach(hash);
  }
  return {executionGasUsed: String(gasUsed), effectiveGasPriceWei: String(price), observedExecutionFeeWei: String(gasUsed * price)};
}
/** No network names, URLs or RPC error text are included in persisted observations. */
export async function observeSettlement(rpc, network, record, now = Date.now()) {
  const signed = assertJournalBinding(record, network), policy = confirmationPolicy(network.confirmationPolicy);
  const snapshot = await rpc.snapshot(network, now);
  const receipt = await rpc.agree(network, 'eth_getTransactionReceipt', [signed.transactionHash]);
  if (receipt === null) {
    const prior = previousReceipt(record); let changed = false;
    if (prior) {
      const current = await rpc.agree(network, 'eth_getBlockByNumber', [prior.blockNumber, false]);
      // A null block or a lower head is uncertainty, not positive reorg evidence.
      changed = !!current && sameQuantity(current.number, prior.blockNumber) && hash(current.hash) !== hash(prior.blockHash);
    }
    return uncertainObservation(record, now, changed ? 'receipt-missing-after-observed-reorg' : 'not-found-does-not-prove-failure',
      {reorgObserved: changed, policy, headBlockHash: snapshot.hash, headBlockNumber: snapshot.number});
  }
  const fees = assertReceipt(receipt, signed);
  const height = q(receipt.blockNumber);
  need(height <= q(snapshot.number), 'RECEIPT_AHEAD_OF_COMMON_HEAD');
  const block = requireBlock(await rpc.agree(network, 'eth_getBlockByNumber', [receipt.blockNumber, false]), receipt.blockNumber, receipt.blockHash);
  // Exact transaction content AND index are checked; no arbitrary receipt status promotion.
  const transaction = await rpc.agree(network, 'eth_getTransactionByHash', [signed.transactionHash]);
  assertTransactionObservation(transaction, receipt, signed);
  need(Array.isArray(block.transactions) && block.transactions.length <= 100000, 'RECEIPT_BLOCK_TRANSACTIONS_UNAVAILABLE');
  const index = q(receipt.transactionIndex);
  need(index < BigInt(block.transactions.length) && hash(block.transactions[Number(index)]) === signed.transactionHash, 'RECEIPT_BLOCK_TRANSACTION_INDEX_MISMATCH');
  const confirmations = q(snapshot.number) - height + 1n;
  let finalityTagSatisfied = policy.finalityTag === 'none', finalityBlock = null;
  if (policy.finalityTag !== 'none') {
    const tagged = await rpc.agree(network, 'eth_getBlockByNumber', [policy.finalityTag, false]);
    need(tagged && q(tagged.number) <= q(snapshot.number), 'FINALITY_TAG_UNAVAILABLE_OR_INCONSISTENT');
    hash(tagged.hash);
    requireBlock(await rpc.agree(network, 'eth_getBlockByNumber', [tagged.number, false]), tagged.number, tagged.hash, 'FINALITY_BLOCK_NOT_CANONICAL');
    finalityBlock = {hash: tagged.hash.toLowerCase(), number: tagged.number};
    finalityTagSatisfied = q(tagged.number) >= height;
  }
  // Fence the entire multi-call observation against a canonical-chain change during the read.
  requireBlock(await rpc.agree(network, 'eth_getBlockByNumber', [snapshot.number, false]), snapshot.number, snapshot.hash, 'HEAD_CHANGED_DURING_RECONCILIATION');
  requireBlock(await rpc.agree(network, 'eth_getBlockByNumber', [receipt.blockNumber, false]), receipt.blockNumber, receipt.blockHash, 'RECEIPT_CHANGED_DURING_RECONCILIATION');
  const transfer = transferReceiptObservation(record, receipt), prior = previousReceipt(record);
  return {schema: 'realdex.settlement-observation.v1', observedAt: now, observation: 'receipt-observed',
    blockHash: hash(receipt.blockHash), blockNumber: quantity(height), transactionIndex: quantity(index),
    headBlockHash: snapshot.hash, headBlockNumber: snapshot.number, confirmations: String(confirmations), policy,
    policySatisfied: confirmations >= BigInt(policy.minConfirmations) && finalityTagSatisfied,
    finalityTagSatisfied, finalityBlock, transactionContentMatched: true,
    reorgObserved: !!prior && prior.blockHash !== hash(receipt.blockHash), lastKnownReceipt: prior,
    deliveryObserved: transfer.transactionReportedSuccessful && (record.summary.operation === 'native-transfer' || transfer.matchingTransferEventObserved === true),
    ...fees, ...transfer, ...smartReceiptObservation(record,receipt), automaticRetry: false,
    assurance: 'Agreement of configured RPCs and signed-transaction binding, not independently verified consensus or account balance change'};
}
