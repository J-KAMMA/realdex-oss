import { getAddress, isError } from "ethers";
import type { EvmSubmittedTransactionEvidence, EvmTransactionEnvelopeEvidence, EvmTransactionReceiptEvidence } from "../routing/types";

export type EvmTransactionLike = {
  hash: string;
  from: string;
  to: string | null;
  nonce: number;
  data: string;
  value: bigint;
  chainId: bigint;
  wait(): Promise<EvmReceiptLike | null>;
  replaceableTransaction?(startBlock: number): { wait(): Promise<EvmReceiptLike | null> };
};

type EvmReceiptLike = { hash: string; status: number | null; blockNumber: number; blockHash: string };

export type EvmTransactionWaitResult = {
  state: "confirmed" | "reverted" | "unknown" | "replaced";
  transaction: EvmSubmittedTransactionEvidence;
  receipt?: EvmTransactionReceiptEvidence;
};

export function bindSubmittedEvmTransaction(transaction: EvmTransactionLike, expected: EvmTransactionEnvelopeEvidence, observedBeforeBlock: number): EvmSubmittedTransactionEvidence {
  const actual = envelopeOf(transaction);
  assertEnvelope(actual);
  assertEnvelope(expected);
  if (!Number.isSafeInteger(observedBeforeBlock) || observedBeforeBlock < 0) throw new Error("EVM_TRANSACTION_START_BLOCK_INVALID");
  if (!sameEnvelope(actual, expected)) throw new Error("EVM_TRANSACTION_ENVELOPE_MISMATCH");
  if (!isTxHash(transaction.hash)) throw new Error("EVM_TRANSACTION_HASH_INVALID");
  return { ...actual, observedBeforeBlock };
}

export async function waitForBoundEvmTransaction(transaction: EvmTransactionLike, evidence: EvmSubmittedTransactionEvidence): Promise<EvmTransactionWaitResult> {
  assertEnvelope(evidence);
  if (!isTxHash(transaction.hash) || !sameEnvelope(envelopeOf(transaction), evidence)) throw new Error("EVM_TRANSACTION_ENVELOPE_CHANGED");
  try {
    const replaceable = transaction.replaceableTransaction?.(evidence.observedBeforeBlock) ?? transaction;
    const receipt = await replaceable.wait();
    if (!receipt) return { state: "unknown", transaction: evidence };
    const normalized = normalizeReceipt(receipt, transaction.hash);
    return { state: normalized.status === 1 ? "confirmed" : "reverted", transaction: evidence, receipt: normalized };
  } catch (reason) {
    if (isError(reason, "TRANSACTION_REPLACED")) {
      const replacement = envelopeOf(reason.replacement);
      assertEnvelope(replacement);
      if (replacement.from.toLowerCase() !== evidence.from.toLowerCase() || replacement.nonce !== evidence.nonce || replacement.chainId !== evidence.chainId || reason.replacement.hash.toLowerCase() === transaction.hash.toLowerCase()) throw new Error("EVM_TRANSACTION_REPLACEMENT_MISMATCH");
      const normalized = normalizeReceipt(reason.receipt, reason.replacement.hash);
      const exact = sameEnvelope(replacement, evidence);
      const replacementEvidence = { ...replacement, hash: reason.replacement.hash.toLowerCase(), reason: exact && reason.reason === "repriced" && !reason.cancelled ? "repriced" as const : cancellationEnvelope(replacement) ? "cancelled" as const : "replaced" as const };
      const nextEvidence = { ...evidence, replacement: replacementEvidence };
      if (!exact || replacementEvidence.reason !== "repriced") return { state: "replaced", transaction: nextEvidence, receipt: normalized };
      return { state: normalized.status === 1 ? "confirmed" : "reverted", transaction: nextEvidence, receipt: normalized };
    }
    if (isError(reason, "CALL_EXCEPTION") && reason.receipt) {
      return { state: "reverted", transaction: evidence, receipt: normalizeReceipt(reason.receipt, transaction.hash) };
    }
    throw reason;
  }
}

export function sameEvmEnvelope(left: EvmTransactionEnvelopeEvidence, right: EvmTransactionEnvelopeEvidence): boolean {
  assertEnvelope(left); assertEnvelope(right);
  return sameEnvelope(left, right);
}

export function cancellationEnvelope(value: EvmTransactionEnvelopeEvidence): boolean {
  assertEnvelope(value);
  return value.to.toLowerCase() === value.from.toLowerCase() && value.data === "0x" && value.valueBaseUnits === "0";
}

function envelopeOf(transaction: Pick<EvmTransactionLike, "from" | "to" | "nonce" | "data" | "value" | "chainId">): EvmTransactionEnvelopeEvidence {
  if (!transaction.to) throw new Error("EVM_TRANSACTION_CONTRACT_CREATION_BLOCKED");
  return {
    from: getAddress(transaction.from), to: getAddress(transaction.to), nonce: transaction.nonce,
    data: transaction.data.toLowerCase(), valueBaseUnits: transaction.value.toString(), chainId: transaction.chainId.toString()
  };
}

function normalizeReceipt(receipt: EvmReceiptLike, expectedHash: string): EvmTransactionReceiptEvidence {
  if (!isTxHash(receipt.hash) || receipt.hash.toLowerCase() !== expectedHash.toLowerCase() || (receipt.status !== 0 && receipt.status !== 1) || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || !isTxHash(receipt.blockHash)) throw new Error("EVM_TRANSACTION_RECEIPT_INVALID");
  return { hash: receipt.hash.toLowerCase(), status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash.toLowerCase() };
}

function assertEnvelope(value: EvmTransactionEnvelopeEvidence): void {
  if (!isAddress(value.from) || !isAddress(value.to) || !Number.isSafeInteger(value.nonce) || value.nonce < 0 || !isHexData(value.data) || value.data.length > 65_538 || !/^(?:0|[1-9]\d*)$/.test(value.valueBaseUnits) || !/^[1-9]\d*$/.test(value.chainId)) throw new Error("EVM_TRANSACTION_ENVELOPE_INVALID");
}

function sameEnvelope(left: EvmTransactionEnvelopeEvidence, right: EvmTransactionEnvelopeEvidence): boolean {
  return left.from.toLowerCase() === right.from.toLowerCase() && left.to.toLowerCase() === right.to.toLowerCase() && left.nonce === right.nonce && left.data.toLowerCase() === right.data.toLowerCase() && left.valueBaseUnits === right.valueBaseUnits && left.chainId === right.chainId;
}

function isAddress(value: unknown): value is string { try { if (typeof value !== "string") return false; getAddress(value); return true; } catch { return false; } }
function isHexData(value: unknown): value is string { return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value); }
function isTxHash(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value); }
