import { getAddress, type JsonRpcProvider } from "ethers";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { routeDescriptorFingerprint, routeRequestFingerprint } from "../routing/engine";
import type { EvmSubmittedTransactionEvidence, EvmTransactionEnvelopeEvidence, RouteDescriptor, RouteExecutionReceipt, RouteQuote, RouteQuoteRequest } from "../routing/types";
import { cancellationEnvelope, sameEvmEnvelope } from "./evm-transaction-lifecycle";

export const EVM_SWAP_RECOVERY_STORAGE_KEY = "localswap:evm-swap-recovery-journal:v1";
export const REPLACEMENT_SCAN_BLOCKS_PER_REFRESH = 24;
const MAX_RECORDS = 16;
const REQUIRED_CONFIRMATIONS = 2;

export type EvmSwapRecoveryStage =
  | "approval-submitted" | "approval-confirmed" | "approval-reverted" | "approval-replaced"
  | "stopped-after-approval" | "swap-submitted" | "replacement-searching"
  | "swap-included" | "swap-confirmed" | "swap-reverted" | "swap-replaced" | "unknown";

export type EvmSwapRecoveryTransaction = {
  role: "approval" | "swap";
  hash: string;
  state: "submitted" | "searching" | "confirmed" | "reverted" | "replaced" | "unknown";
  blockNumber: number | null;
  blockHash: string | null;
  confirmations: number | null;
  envelope?: EvmSubmittedTransactionEvidence;
  nextSearchBlock?: number;
};

export type EvmSwapRecoveryRecord = {
  schema: "localswap.evm-swap-recovery.v1" | "localswap.evm-swap-recovery.v2" | "realdex.evm-swap-recovery.v3";
  recoveryId: string; executionId: string; routeId: string; routeFingerprint: string;
  quoteId: string; requestFingerprint: string; chainId: string; accountId: string; recipient: string;
  source: { assetType: string; symbol: string; decimals: number; amountBaseUnits: string };
  destination: { assetType: string; symbol: string; decimals: number; minimumOutBaseUnits: string };
  executionTarget: string; executionMethod: string; provider: string; stage: EvmSwapRecoveryStage;
  transactions: EvmSwapRecoveryTransaction[]; requiredConfirmations: number; revision: number; createdAt: number; updatedAt: number;
};

export type EvmSwapRecoveryDisplay = { sourceSymbol: string; sourceDecimals: number; destinationSymbol: string; destinationDecimals: number };
export type EvmObservedTransaction = EvmTransactionEnvelopeEvidence & { hash: string; blockNumber: number | null };
export type EvmObservedBlock = { number: number; hash: string; transactions: EvmObservedTransaction[] };
export type EvmSwapRecoveryReader = {
  chainId(): Promise<bigint>;
  blockNumber(): Promise<number>;
  receipt(hash: string): Promise<{ transactionHash: string; status: number | null; blockNumber: number; blockHash: string } | null>;
  transaction(hash: string): Promise<EvmObservedTransaction | null>;
  transactionCount(address: string): Promise<number>;
  block(number: number): Promise<EvmObservedBlock | null>;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function recordEvmSwapReceipt(route: RouteDescriptor, request: RouteQuoteRequest, quote: RouteQuote, receipt: RouteExecutionReceipt, display: EvmSwapRecoveryDisplay, previous?: EvmSwapRecoveryRecord, now = Date.now()): EvmSwapRecoveryRecord | undefined {
  assertStaticBinding(route, request, quote, receipt); assertDisplay(display);
  if (previous && previous.schema !== "realdex.evm-swap-recovery.v3") throw new Error("EVM_SWAP_RECOVERY_LEGACY_APPEND_BLOCKED");
  const transactions = transactionSteps(receipt, previous);
  if (!transactions.length) return undefined;
  const recoveryId = recoveryIdentity(route, request, quote);
  if (previous) { assertEvmSwapRecoveryRecord(previous); if (previous.recoveryId !== recoveryId) throw new Error("EVM_SWAP_RECOVERY_IDENTITY_CHANGED"); }
  if (!transactions.every((transaction) => transaction.envelope)) throw new Error("EVM_SWAP_RECOVERY_EVIDENCE_INCOMPLETE");
  const schema = "realdex.evm-swap-recovery.v3" as const;
  const stage = stageFromReceipt(receipt, transactions);
  if (previous) assertStageTransition(previous.stage, stage);
  const record: EvmSwapRecoveryRecord = {
    schema, recoveryId, executionId: receipt.executionId, routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route), quoteId: quote.quoteId,
    requestFingerprint: routeRequestFingerprint(request), chainId: chainIdOf(route.sourceAsset), accountId: request.accountId, recipient: request.recipient,
    source: { assetType: route.sourceAsset, symbol: display.sourceSymbol, decimals: display.sourceDecimals, amountBaseUnits: request.amountInBaseUnits.toString() },
    destination: { assetType: route.destinationAsset, symbol: display.destinationSymbol, decimals: display.destinationDecimals, minimumOutBaseUnits: quote.minimumOutBaseUnits.toString() },
    executionTarget: route.sourceExecutionTarget, executionMethod: route.executionMethod, provider: receipt.provider, stage, transactions,
    requiredConfirmations: REQUIRED_CONFIRMATIONS, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now
  };
  assertEvmSwapRecoveryRecord(record); return record;
}

export async function refreshEvmSwapRecovery(record: EvmSwapRecoveryRecord, reader: EvmSwapRecoveryReader, now = Date.now()): Promise<EvmSwapRecoveryRecord> {
  assertEvmSwapRecoveryRecord(record);
  if (`eip155:${await reader.chainId()}` !== record.chainId) throw new Error("EVM_SWAP_RECOVERY_CHAIN_MISMATCH");
  const head = await reader.blockNumber();
  if (!Number.isSafeInteger(head) || head < 0) throw new Error("EVM_SWAP_RECOVERY_HEAD_INVALID");
  const transactions: EvmSwapRecoveryTransaction[] = [];
  for (const transaction of record.transactions) transactions.push(await refreshTransaction(transaction, reader, head));
  if (`eip155:${await reader.chainId()}` !== record.chainId) throw new Error("EVM_SWAP_RECOVERY_CHAIN_MISMATCH");
  const approval = transactions.find((transaction) => transaction.role === "approval"), swap = transactions.find((transaction) => transaction.role === "swap");
  if ((approval?.state === "reverted" || approval?.state === "replaced") && swap) throw new Error("EVM_SWAP_RECOVERY_SEQUENCE_INVALID");
  const stage = refreshedStage(record.stage, approval, swap, record.requiredConfirmations);
  assertStageTransition(record.stage, stage, true);
  const next = { ...record, stage, transactions, revision: record.revision + 1, updatedAt: now };
  assertEvmSwapRecoveryRecord(next); return next;
}

export function createJsonRpcEvmSwapRecoveryReader(provider: JsonRpcProvider): EvmSwapRecoveryReader {
  const observed = (transaction: { hash: string; from: string; to: string | null; nonce: number; data: string; value: bigint; chainId: bigint; blockNumber?: number | null }): EvmObservedTransaction => {
    if (!transaction.to) throw new Error("EVM_SWAP_RECOVERY_TRANSACTION_INVALID");
    return { hash: transaction.hash.toLowerCase(), from: getAddress(transaction.from), to: getAddress(transaction.to), nonce: transaction.nonce, data: transaction.data.toLowerCase(), valueBaseUnits: transaction.value.toString(), chainId: transaction.chainId.toString(), blockNumber: transaction.blockNumber ?? null };
  };
  return {
    chainId: async () => BigInt(await provider.send("eth_chainId", [])), blockNumber: () => provider.getBlockNumber(),
    receipt: async (hash) => { const value = await provider.getTransactionReceipt(hash); return value ? { transactionHash: value.hash, status: value.status, blockNumber: value.blockNumber, blockHash: value.blockHash } : null; },
    transaction: async (hash) => { const value = await provider.getTransaction(hash); return value ? observed(value) : null; },
    transactionCount: (address) => provider.getTransactionCount(address, "latest"),
    block: async (number) => { const value = await provider.getBlock(number, true); return value ? { number: value.number, hash: value.hash!, transactions: value.prefetchedTransactions.map(observed) } : null; }
  };
}

export function readEvmSwapRecoveryJournal(storage: StorageLike = localStorage): EvmSwapRecoveryRecord[] {
  const raw = storage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY); if (!raw) return [];
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error("EVM_SWAP_RECOVERY_STORAGE_INVALID"); }
  if (!isRecord(parsed) || !exactKeys(parsed, ["schema", "records"]) || parsed.schema !== "localswap.evm-swap-recovery-journal.v1" || !Array.isArray(parsed.records) || parsed.records.length > MAX_RECORDS) throw new Error("EVM_SWAP_RECOVERY_STORAGE_INVALID");
  const records = parsed.records.map(assertEvmSwapRecoveryRecord);
  if (new Set(records.map((record) => record.recoveryId)).size !== records.length) throw new Error("EVM_SWAP_RECOVERY_STORAGE_INVALID");
  return records.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function writeEvmSwapRecoveryRecord(record: EvmSwapRecoveryRecord, storage: StorageLike = localStorage): EvmSwapRecoveryRecord[] {
  assertEvmSwapRecoveryRecord(record); const existing = readEvmSwapRecoveryJournal(storage), prior = existing.find((item) => item.recoveryId === record.recoveryId);
  if (prior && record.revision <= prior.revision) throw new Error("EVM_SWAP_RECOVERY_REVISION_NOT_ADVANCED");
  if (!prior && existing.length >= MAX_RECORDS) throw new Error("EVM_SWAP_RECOVERY_STORAGE_FULL");
  if (prior) assertJournalAdvance(prior, record);
  const records = [record, ...existing.filter((item) => item.recoveryId !== record.recoveryId)].sort((left, right) => right.updatedAt - left.updatedAt);
  const serialized = JSON.stringify({ schema: "localswap.evm-swap-recovery-journal.v1", records });
  storage.setItem(EVM_SWAP_RECOVERY_STORAGE_KEY, serialized);
  if (storage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY) !== serialized) throw new Error("EVM_SWAP_RECOVERY_STORAGE_NOT_CONFIRMED");
  return records;
}

/** Check inside the execution lock before any signature request. Never evict history implicitly. */
export function assertEvmSwapRecoveryCapacity(storage: StorageLike = localStorage): void {
  if (readEvmSwapRecoveryJournal(storage).length >= MAX_RECORDS) throw new Error("EVM_SWAP_RECOVERY_STORAGE_FULL");
}

function assertJournalAdvance(prior: EvmSwapRecoveryRecord, next: EvmSwapRecoveryRecord): void {
  const identity = ({ executionId: _executionId, stage: _stage, transactions: _transactions, revision: _revision, updatedAt: _updatedAt, ...fixed }: EvmSwapRecoveryRecord) => cryptographicFingerprint("realdex.recovery-journal-binding.v1", fixed);
  if (identity(prior) !== identity(next)) throw new Error("EVM_SWAP_RECOVERY_IDENTITY_CHANGED");
  if (next.updatedAt < prior.updatedAt) throw new Error("EVM_SWAP_RECOVERY_TIME_REGRESSION");
  assertStageTransition(prior.stage, next.stage, true);
  for (const old of prior.transactions) {
    const current = next.transactions.find(transaction => transaction.role === old.role);
    if (!current || current.hash.toLowerCase() !== old.hash.toLowerCase()) throw new Error("EVM_SWAP_RECOVERY_TRANSACTION_CHANGED");
    if (old.envelope && (!current.envelope || !sameEvmEnvelope(old.envelope, current.envelope) || old.envelope.observedBeforeBlock !== current.envelope.observedBeforeBlock)) throw new Error("EVM_SWAP_RECOVERY_TRANSACTION_CHANGED");
    if (old.envelope?.replacement && (!current.envelope?.replacement || cryptographicFingerprint("realdex.recovery-replacement.v1", old.envelope.replacement) !== cryptographicFingerprint("realdex.recovery-replacement.v1", current.envelope.replacement))) throw new Error("EVM_SWAP_RECOVERY_TRANSACTION_CHANGED");
  }
}

export function assertEvmSwapRecoveryRecord(value: unknown): EvmSwapRecoveryRecord {
  if (!isRecord(value) || !exactKeys(value, ["schema", "recoveryId", "executionId", "routeId", "routeFingerprint", "quoteId", "requestFingerprint", "chainId", "accountId", "recipient", "source", "destination", "executionTarget", "executionMethod", "provider", "stage", "transactions", "requiredConfirmations", "revision", "createdAt", "updatedAt"])) throw new Error("EVM_SWAP_RECOVERY_RECORD_INVALID");
  const record = value as unknown as EvmSwapRecoveryRecord;
  const legacy = record.schema === "localswap.evm-swap-recovery.v1" || record.schema === "localswap.evm-swap-recovery.v2";
  const fingerprint = legacy ? /^fnv1a:[0-9a-f]{8}$/ : /^0x[0-9a-f]{64}$/;
  if (!["localswap.evm-swap-recovery.v1", "localswap.evm-swap-recovery.v2", "realdex.evm-swap-recovery.v3"].includes(record.schema) || !fingerprint.test(record.recoveryId) || !bounded(record.executionId, 800) || !bounded(record.routeId, 800) || !fingerprint.test(record.routeFingerprint) || !bounded(record.quoteId, 1600) || !fingerprint.test(record.requestFingerprint)) throw new Error("EVM_SWAP_RECOVERY_RECORD_INVALID");
  if (!/^eip155:[1-9]\d*$/.test(record.chainId) || !record.accountId.toLowerCase().startsWith(`${record.chainId}:`) || !isEvmAccountId(record.accountId) || !isAddress(record.recipient) || !isAddress(record.executionTarget) || !bounded(record.executionMethod, 100) || !bounded(record.provider, 200)) throw new Error("EVM_SWAP_RECOVERY_RECORD_INVALID");
  assertAsset(record.source, record.chainId, "amountBaseUnits"); assertAsset(record.destination, record.chainId, "minimumOutBaseUnits");
  if (!STAGES.includes(record.stage) || record.requiredConfirmations !== REQUIRED_CONFIRMATIONS || !Number.isSafeInteger(record.revision) || record.revision <= 0 || !validTime(record.createdAt) || !validTime(record.updatedAt) || record.updatedAt < record.createdAt || !Array.isArray(record.transactions) || record.transactions.length < 1 || record.transactions.length > 2) throw new Error("EVM_SWAP_RECOVERY_RECORD_INVALID");
  const roles = new Set<string>();
  for (const transaction of record.transactions) {
    const withEnvelope = record.schema !== "localswap.evm-swap-recovery.v1", keys = withEnvelope ? ["role", "hash", "state", "blockNumber", "blockHash", "confirmations", "envelope", "nextSearchBlock"] : ["role", "hash", "state", "blockNumber", "blockHash", "confirmations"];
    if (!isRecord(transaction) || !exactKeys(transaction, keys) || !["approval", "swap"].includes(String(transaction.role)) || roles.has(String(transaction.role)) || !isTxHash(transaction.hash) || !(withEnvelope ? ["submitted", "searching", "confirmed", "reverted", "replaced", "unknown"] : ["submitted", "confirmed", "reverted", "unknown"]).includes(String(transaction.state))) throw new Error("EVM_SWAP_RECOVERY_RECORD_INVALID");
    roles.add(String(transaction.role));
    if (withEnvelope && (!isSubmittedEvidence(transaction.envelope) || !Number.isSafeInteger(transaction.nextSearchBlock) || Number(transaction.nextSearchBlock) <= transaction.envelope.observedBeforeBlock)) throw new Error("EVM_SWAP_RECOVERY_RECORD_INVALID");
    if (transaction.blockNumber === null) { if (transaction.blockHash !== null || (transaction.confirmations !== null && transaction.confirmations !== 0)) throw new Error("EVM_SWAP_RECOVERY_RECORD_INVALID"); }
    else if (!Number.isSafeInteger(transaction.blockNumber) || Number(transaction.blockNumber) < 0 || !isTxHash(transaction.blockHash) || !Number.isSafeInteger(transaction.confirmations) || Number(transaction.confirmations) < 1) throw new Error("EVM_SWAP_RECOVERY_RECORD_INVALID");
  }
  return record;
}

const STAGES: EvmSwapRecoveryStage[] = ["approval-submitted", "approval-confirmed", "approval-reverted", "approval-replaced", "stopped-after-approval", "swap-submitted", "replacement-searching", "swap-included", "swap-confirmed", "swap-reverted", "swap-replaced", "unknown"];

async function refreshTransaction(transaction: EvmSwapRecoveryTransaction, reader: EvmSwapRecoveryReader, head: number): Promise<EvmSwapRecoveryTransaction> {
  const replacement = transaction.envelope?.replacement;
  if (replacement && (replacement.hash.toLowerCase() === transaction.hash.toLowerCase() || replacement.from.toLowerCase() !== transaction.envelope!.from.toLowerCase() ||
      replacement.nonce !== transaction.envelope!.nonce || replacement.chainId !== transaction.envelope!.chainId ||
      replacement.reason !== (sameEvmEnvelope(replacement, transaction.envelope!) ? "repriced" : cancellationEnvelope(replacement) ? "cancelled" : "replaced"))) throw new Error("EVM_SWAP_RECOVERY_REPLACEMENT_MISMATCH");
  const effectiveHash = transaction.envelope?.replacement?.hash ?? transaction.hash, receipt = await reader.receipt(effectiveHash);
  if (receipt) return applyReceipt(transaction, receipt, effectiveHash, head, transaction.state === "replaced" || (replacement && replacement.reason !== "repriced") ? "replaced" : undefined);
  if (["confirmed", "reverted", "replaced"].includes(transaction.state)) throw new Error("EVM_SWAP_RECOVERY_RECEIPT_REGRESSED");
  if (!transaction.envelope || transaction.nextSearchBlock === undefined) return { ...transaction, state: "submitted", blockNumber: null, blockHash: null, confirmations: 0 };
  const expected = transaction.envelope.replacement ?? transaction.envelope, visible = await reader.transaction(effectiveHash);
  if (visible) { if (!sameEvmEnvelope(visible, expected)) throw new Error("EVM_SWAP_RECOVERY_TRANSACTION_CHANGED"); return { ...transaction, state: "submitted", blockNumber: null, blockHash: null, confirmations: 0 }; }
  const count = await reader.transactionCount(transaction.envelope.from);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("EVM_SWAP_RECOVERY_NONCE_INVALID");
  if (count <= transaction.envelope.nonce) return { ...transaction, state: "submitted", blockNumber: null, blockHash: null, confirmations: 0 };
  const end = Math.min(head, transaction.nextSearchBlock + REPLACEMENT_SCAN_BLOCKS_PER_REFRESH - 1);
  for (let number = transaction.nextSearchBlock; number <= end; number++) {
    const block = await reader.block(number); if (!block || block.number !== number || !isTxHash(block.hash)) throw new Error("EVM_SWAP_RECOVERY_BLOCK_INVALID");
    const candidate = block.transactions.find((item) => item.from.toLowerCase() === transaction.envelope!.from.toLowerCase() && item.nonce === transaction.envelope!.nonce);
    if (!candidate) continue;
    if (!isTxHash(candidate.hash) || candidate.chainId !== transaction.envelope.chainId) throw new Error("EVM_SWAP_RECOVERY_TRANSACTION_INVALID");
    if (candidate.hash.toLowerCase() === transaction.hash.toLowerCase()) continue;
    const reason = sameEvmEnvelope(candidate, transaction.envelope) ? "repriced" as const : cancellationEnvelope(candidate) ? "cancelled" as const : "replaced" as const;
    const envelope = { ...transaction.envelope, replacement: { from: candidate.from, to: candidate.to, nonce: candidate.nonce, data: candidate.data, valueBaseUnits: candidate.valueBaseUnits, chainId: candidate.chainId, hash: candidate.hash.toLowerCase(), reason } };
    const replacementReceipt = await reader.receipt(candidate.hash);
    if (!replacementReceipt) return { ...transaction, envelope, nextSearchBlock: number + 1, state: "searching", blockNumber: null, blockHash: null, confirmations: 0 };
    return applyReceipt({ ...transaction, envelope }, replacementReceipt, candidate.hash, head, reason === "repriced" ? undefined : "replaced");
  }
  return { ...transaction, nextSearchBlock: Math.max(transaction.nextSearchBlock, end + 1), state: "searching", blockNumber: null, blockHash: null, confirmations: 0 };
}

function applyReceipt(transaction: EvmSwapRecoveryTransaction, receipt: { transactionHash: string; status: number | null; blockNumber: number; blockHash: string }, expectedHash: string, head: number, forced?: "replaced"): EvmSwapRecoveryTransaction {
  if (receipt.transactionHash.toLowerCase() !== expectedHash.toLowerCase() || !isTxHash(receipt.blockHash) || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || receipt.blockNumber > head || (receipt.status !== 0 && receipt.status !== 1)) throw new Error("EVM_SWAP_RECOVERY_RECEIPT_INVALID");
  return { ...transaction, state: forced ?? (receipt.status === 1 ? "confirmed" : "reverted"), blockNumber: receipt.blockNumber, blockHash: receipt.blockHash.toLowerCase(), confirmations: head - receipt.blockNumber + 1 };
}

function refreshedStage(previous: EvmSwapRecoveryStage, approval: EvmSwapRecoveryTransaction | undefined, swap: EvmSwapRecoveryTransaction | undefined, confirmations: number): EvmSwapRecoveryStage {
  const active = swap ?? approval; if (!active) throw new Error("EVM_SWAP_RECOVERY_TRANSACTION_MISSING");
  if (active.state === "searching") return "replacement-searching";
  if (swap) return swap.state === "replaced" ? "swap-replaced" : swap.state === "reverted" ? "swap-reverted" : swap.state === "confirmed" ? ((swap.confirmations ?? 0) >= confirmations ? "swap-confirmed" : "swap-included") : "swap-submitted";
  return approval!.state === "replaced" ? "approval-replaced" : approval!.state === "reverted" ? "approval-reverted" : approval!.state === "confirmed" ? (previous === "stopped-after-approval" ? "stopped-after-approval" : "approval-confirmed") : "approval-submitted";
}

function assertStaticBinding(route: RouteDescriptor, request: RouteQuoteRequest, quote: RouteQuote, receipt: RouteExecutionReceipt): void {
  const routeFingerprint = routeDescriptorFingerprint(route), requestFingerprint = routeRequestFingerprint(request);
  if (route.operation !== "swap" || !route.sourceAsset.startsWith("eip155:") || chainIdOf(route.sourceAsset) !== chainIdOf(route.destinationAsset) || quote.routeId !== route.id || quote.routeFingerprint !== routeFingerprint || quote.requestFingerprint !== requestFingerprint || quote.quoteId !== receipt.quoteId || quote.amountInBaseUnits !== request.amountInBaseUnits || quote.minimumOutBaseUnits <= 0n || quote.executionPreview.chainId !== chainIdOf(route.sourceAsset) || quote.executionPreview.target.toLowerCase() !== route.sourceExecutionTarget.toLowerCase() || quote.executionPreview.method !== route.executionMethod) throw new Error("EVM_SWAP_RECOVERY_BINDING_INVALID");
}

function transactionSteps(receipt: RouteExecutionReceipt, previous?: EvmSwapRecoveryRecord): EvmSwapRecoveryTransaction[] {
  const prior = new Map(previous?.transactions.map((transaction) => [transaction.role, transaction]) ?? []), transactions: EvmSwapRecoveryTransaction[] = [];
  for (const role of ["approval", "swap"] as const) {
    const matches = receipt.steps.filter((step) => step.kind === role && step.txHash); if (matches.length > 1) throw new Error("EVM_SWAP_RECOVERY_TRANSACTION_AMBIGUOUS");
    const step = matches[0], earlier = prior.get(role); if (!step) { if (earlier) transactions.push(earlier); continue; }
    const hash = step.txHash!; if (!isTxHash(hash) || (earlier && earlier.hash.toLowerCase() !== hash.toLowerCase())) throw new Error("EVM_SWAP_RECOVERY_TRANSACTION_CHANGED");
    const state = step.state === "confirmed" ? "confirmed" : step.state === "reverted" || step.state === "failed" ? "reverted" : step.state === "replaced" ? "replaced" : step.state === "unknown" ? "unknown" : "submitted";
    const envelope = step.evmTransaction ?? earlier?.envelope;
    if (earlier?.envelope && envelope && (!sameEvmEnvelope(earlier.envelope, envelope) || (earlier.envelope.replacement !== undefined && JSON.stringify(earlier.envelope.replacement) !== JSON.stringify(envelope.replacement)))) throw new Error("EVM_SWAP_RECOVERY_TRANSACTION_CHANGED");
    let next: EvmSwapRecoveryTransaction = { role, hash: hash.toLowerCase(), state, blockNumber: earlier?.blockNumber ?? null, blockHash: earlier?.blockHash ?? null, confirmations: earlier?.confirmations ?? null };
    if (envelope) next = { ...next, envelope, nextSearchBlock: earlier?.nextSearchBlock ?? envelope.observedBeforeBlock + 1 };
    if (step.evmReceipt) next = applyReceipt(next, { transactionHash: step.evmReceipt.hash, status: step.evmReceipt.status, blockNumber: step.evmReceipt.blockNumber, blockHash: step.evmReceipt.blockHash }, step.evmReceipt.hash, step.evmReceipt.blockNumber, state === "replaced" ? "replaced" : undefined);
    transactions.push(next);
  }
  return transactions;
}

function stageFromReceipt(receipt: RouteExecutionReceipt, transactions: EvmSwapRecoveryTransaction[]): EvmSwapRecoveryStage {
  const swap = transactions.find((transaction) => transaction.role === "swap");
  if (swap) return swap.state === "confirmed" ? "swap-included" : swap.state === "reverted" ? "swap-reverted" : swap.state === "replaced" ? "swap-replaced" : swap.state === "unknown" || receipt.state === "unknown" ? "unknown" : "swap-submitted";
  const approval = transactions.find((transaction) => transaction.role === "approval"); if (!approval) throw new Error("EVM_SWAP_RECOVERY_TRANSACTION_MISSING");
  if (approval.state === "reverted") return "approval-reverted"; if (approval.state === "replaced") return "approval-replaced"; if (approval.state === "unknown" || receipt.state === "unknown") return "unknown";
  // A failed response with only a saved approval can also follow an unrecorded swap.
  // Do not turn missing evidence into the no-send state used to release the UI guard.
  if (receipt.state === "failed" && approval.state === "confirmed") return receipt.failureProof?.type === "no-value-transfer-submitted" ? "stopped-after-approval" : "unknown";
  return approval.state === "confirmed" ? "approval-confirmed" : "approval-submitted";
}

function assertStageTransition(previous: EvmSwapRecoveryStage, next: EvmSwapRecoveryStage, refresh = false): void {
  if (previous === next) return;
  if (["approval-reverted", "approval-replaced", "swap-confirmed", "swap-reverted", "swap-replaced"].includes(previous)) throw new Error("EVM_SWAP_RECOVERY_STAGE_REGRESSION");
  if (previous === "stopped-after-approval" && !(refresh && next === "approval-confirmed")) throw new Error("EVM_SWAP_RECOVERY_STAGE_REGRESSION");
  if (previous === "swap-included" && !["swap-confirmed", "swap-reverted", "swap-replaced", "unknown"].includes(next)) throw new Error("EVM_SWAP_RECOVERY_STAGE_REGRESSION");
  if (previous.startsWith("swap-") && !["replacement-searching", "swap-included", "swap-confirmed", "swap-reverted", "swap-replaced", "unknown"].includes(next)) throw new Error("EVM_SWAP_RECOVERY_STAGE_REGRESSION");
  if (previous === "replacement-searching" && !["approval-confirmed", "approval-reverted", "approval-replaced", "swap-submitted", "swap-included", "swap-confirmed", "swap-reverted", "swap-replaced", "unknown"].includes(next)) throw new Error("EVM_SWAP_RECOVERY_STAGE_REGRESSION");
}

function isSubmittedEvidence(value: unknown): value is EvmSubmittedTransactionEvidence {
  if (!isRecord(value) || !isEnvelope(value) || !Number.isSafeInteger(value.observedBeforeBlock) || Number(value.observedBeforeBlock) < 0 || Object.keys(value).some((key) => !["from", "to", "nonce", "data", "valueBaseUnits", "chainId", "observedBeforeBlock", "replacement"].includes(key))) return false;
  return value.replacement === undefined || (isRecord(value.replacement) && isEnvelope(value.replacement) && isTxHash(value.replacement.hash) && ["repriced", "cancelled", "replaced"].includes(String(value.replacement.reason)) && exactKeys(value.replacement, ["from", "to", "nonce", "data", "valueBaseUnits", "chainId", "hash", "reason"]));
}
function isEnvelope(value: Record<string, unknown>): boolean { return isAddress(value.from) && isAddress(value.to) && Number.isSafeInteger(value.nonce) && Number(value.nonce) >= 0 && typeof value.data === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value.data) && value.data.length <= 65_538 && typeof value.valueBaseUnits === "string" && /^(?:0|[1-9]\d*)$/.test(value.valueBaseUnits) && typeof value.chainId === "string" && /^[1-9]\d*$/.test(value.chainId); }
export function evmSwapRecoveryIdentity(routeFingerprint: string, requestFingerprint: string, quoteId: string): string { return cryptographicFingerprint("realdex.evm-swap-recovery.v3", { routeFingerprint, requestFingerprint, quoteId }); }
function recoveryIdentity(route: RouteDescriptor, request: RouteQuoteRequest, quote: RouteQuote): string { return evmSwapRecoveryIdentity(routeDescriptorFingerprint(route), routeRequestFingerprint(request), quote.quoteId); }
function assertDisplay(display: EvmSwapRecoveryDisplay): void { if (!bounded(display.sourceSymbol, 24) || !bounded(display.destinationSymbol, 24) || !validDecimals(display.sourceDecimals) || !validDecimals(display.destinationDecimals)) throw new Error("EVM_SWAP_RECOVERY_DISPLAY_INVALID"); }
function assertAsset(value: unknown, chainId: string, amountKey: "amountBaseUnits" | "minimumOutBaseUnits"): void { if (!isRecord(value) || !exactKeys(value, ["assetType", "symbol", "decimals", amountKey]) || typeof value.assetType !== "string" || !value.assetType.startsWith(`${chainId}/erc20:`) || !isAddress(value.assetType.slice(value.assetType.indexOf("/erc20:") + 7)) || !bounded(value.symbol, 24) || !validDecimals(value.decimals) || typeof value[amountKey] !== "string" || !/^[1-9]\d*$/.test(value[amountKey])) throw new Error("EVM_SWAP_RECOVERY_RECORD_INVALID"); }
function chainIdOf(assetType: string): string { return assetType.slice(0, assetType.indexOf("/")); }
function isAddress(value: unknown): value is string { try { if (typeof value !== "string") return false; getAddress(value); return true; } catch { return false; } }
function isEvmAccountId(value: string): boolean { const address = value.slice(value.lastIndexOf(":") + 1); try { return getAddress(address).toLowerCase() === address.toLowerCase(); } catch { return false; } }
function isTxHash(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value); }
function validDecimals(value: unknown): value is number { return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255; }
function validTime(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
