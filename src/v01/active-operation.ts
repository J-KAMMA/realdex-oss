import { browserCrossTabExecutionLockManager, withCrossTabExecutionLock } from "../routing/cross-tab-execution-lock";
import type { EvmSwapRecoveryRecord } from "../swap/evm-swap-recovery";
import { assertV01SendAttempt, type V01SendAttempt } from "./send-attempt";
import { assertV01RecoveryIntent, assertV01AttemptMatchesRecoveryIntent, type V01RecoveryIntent } from "./recovery-intent";

const KEY = "realdex:v01-active-operation:v1";
type OperationBinding = { intentId: string; quoteId: string; profileFingerprint: string; recoveryId: string | null };
export type ActiveV01Operation = OperationBinding & (
  { schema: "realdex.v01-active-operation.v1" } |
  { schema: "realdex.v01-active-operation.v2"; attempts: V01SendAttempt[] } |
  { schema: "realdex.v01-active-operation.v3"; attempts: V01SendAttempt[]; recovery: V01RecoveryIntent }
);

export function readActiveV01Operation(): ActiveV01Operation | null {
  const raw = localStorage.getItem(KEY);
  if (raw === null) return null;
  const value = JSON.parse(raw);
  assertActiveV01Operation(value);
  return value;
}

export function saveActiveV01Operation(value: ActiveV01Operation): void {
  assertActiveV01Operation(value);
  const previous = readActiveV01Operation();
  if (previous && (previous.intentId !== value.intentId || previous.quoteId !== value.quoteId || previous.profileFingerprint !== value.profileFingerprint || (previous.recoveryId !== null && previous.recoveryId !== value.recoveryId))) throw new Error("V01_UNRESOLVED_OPERATION");
  if (previous && (previous.schema !== value.schema || (previous.schema !== "realdex.v01-active-operation.v1" && value.schema === previous.schema &&
      (value.attempts.length < previous.attempts.length || previous.attempts.some((attempt, index) => JSON.stringify(attempt) !== JSON.stringify(value.attempts[index])))))) throw new Error("V01_SEND_ATTEMPT_CHANGED");
  if (previous?.schema === "realdex.v01-active-operation.v3" && value.schema === previous.schema && JSON.stringify(previous.recovery) !== JSON.stringify(value.recovery)) throw new Error("V01_RECOVERY_INTENT_CHANGED");
  const raw = JSON.stringify(value);
  localStorage.setItem(KEY, raw);
  if (localStorage.getItem(KEY) !== raw) throw new Error("V01_ACTIVE_OPERATION_STORAGE_FAILED");
}

/** Synchronous and called under the operation Web Lock, immediately before wallet IO. */
export function persistV01SendAttempt(attempt: V01SendAttempt): true {
  assertV01SendAttempt(attempt);
  const current = readActiveV01Operation();
  if (!current || current.schema === "realdex.v01-active-operation.v1" || current.intentId !== attempt.intentId || current.quoteId !== attempt.quoteId || current.profileFingerprint !== attempt.profileFingerprint) throw new Error("V01_SEND_ATTEMPT_BINDING_MISMATCH");
  saveActiveV01Operation({ ...current, attempts: [...current.attempts, attempt] });
  return true;
}

export function assertActiveV01Operation(value: unknown): asserts value is ActiveV01Operation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V01_ACTIVE_OPERATION_INVALID");
  const item = value as ActiveV01Operation;
  const keys = ["schema", "intentId", "quoteId", "profileFingerprint", "recoveryId", ...(item.schema !== "realdex.v01-active-operation.v1" ? ["attempts"] : []), ...(item.schema === "realdex.v01-active-operation.v3" ? ["recovery"] : [])];
  if (Object.keys(item).sort().join() !== keys.sort().join() || !["realdex.v01-active-operation.v1", "realdex.v01-active-operation.v2", "realdex.v01-active-operation.v3"].includes(item.schema) || !/^realdex-intent:v1:[0-9a-f-]{36}$/.test(item.intentId) || typeof item.quoteId !== "string" || item.quoteId.length > 800 || !/^0x[0-9a-f]{64}$/.test(item.profileFingerprint) || (item.recoveryId !== null && typeof item.recoveryId !== "string")) throw new Error("V01_ACTIVE_OPERATION_INVALID");
  if (item.schema === "realdex.v01-active-operation.v3") {
    assertV01RecoveryIntent(item.recovery);
    if (item.intentId !== item.recovery.intentId || item.quoteId !== item.recovery.quoteId || item.profileFingerprint !== item.recovery.profileFingerprint || (item.recoveryId !== null && item.recoveryId !== item.recovery.recoveryId)) throw new Error("V01_RECOVERY_INTENT_BINDING_MISMATCH");
  }
  if (item.schema !== "realdex.v01-active-operation.v1") {
    if (!Array.isArray(item.attempts) || item.attempts.length > 2) throw new Error("V01_SEND_ATTEMPT_INVALID");
    for (const attempt of item.attempts) {
      assertV01SendAttempt(attempt);
      if (attempt.intentId !== item.intentId || attempt.quoteId !== item.quoteId || attempt.profileFingerprint !== item.profileFingerprint) throw new Error("V01_SEND_ATTEMPT_BINDING_MISMATCH");
      if (item.schema === "realdex.v01-active-operation.v3") assertV01AttemptMatchesRecoveryIntent(attempt, item.recovery);
    }
    if (item.schema === "realdex.v01-active-operation.v3" && item.attempts.length && item.attempts[0].role !== (item.recovery.approvalRequired ? "approval" : "swap")) throw new Error("V01_SEND_ATTEMPT_SEQUENCE_INVALID");
    if (item.attempts.length === 2) {
      const [approval, swap] = item.attempts;
      if (approval.role !== "approval" || swap.role !== "swap" || approval.transaction.from.toLowerCase() !== swap.transaction.from.toLowerCase() ||
          BigInt(swap.transaction.nonce) !== BigInt(approval.transaction.nonce) + 1n || swap.observedBeforeBlock < approval.observedBeforeBlock) throw new Error("V01_SEND_ATTEMPT_SEQUENCE_INVALID");
    }
  }
}

/** Caller must hold the origin-wide operation lock. Never called on timeout/unknown. */
export function clearActiveV01Operation(expected: ActiveV01Operation): void {
  const current = readActiveV01Operation();
  if (!current || current.intentId !== expected.intentId || current.quoteId !== expected.quoteId || current.profileFingerprint !== expected.profileFingerprint) throw new Error("V01_ACTIVE_OPERATION_CHANGED");
  localStorage.removeItem(KEY);
  if (localStorage.getItem(KEY) !== null) throw new Error("V01_ACTIVE_OPERATION_STORAGE_FAILED");
}

export function withV01OperationLock<T>(action: () => Promise<T>): Promise<T> {
  const locks = browserCrossTabExecutionLockManager();
  if (!locks) return Promise.reject(new Error("EXECUTION_GUARD_CROSS_TAB_LOCK_UNAVAILABLE"));
  return withCrossTabExecutionLock(locks, "localswap:route-intent-execution:v01-active-operation", action);
}

/** UI eligibility only: replacement close requires a fresh two-reader check. */
export function canCloseV01Operation(active: ActiveV01Operation, record: EvmSwapRecoveryRecord): boolean {
  if (active.recoveryId !== record.recoveryId || active.quoteId !== record.quoteId || !["swap-confirmed", "swap-reverted", "swap-replaced", "approval-replaced", "approval-reverted", "stopped-after-approval"].includes(record.stage)) return false;
  if (!Array.isArray(record.transactions)) return false;
  if (record.transactions.some(transaction => transaction.envelope?.replacement) && active.schema !== "realdex.v01-active-operation.v3") return false;
  if (record.stage.endsWith("replaced") && (active.schema !== "realdex.v01-active-operation.v3" || !record.transactions.some(transaction => transaction.role === (record.stage.startsWith("swap-") ? "swap" : "approval") && transaction.envelope?.replacement && transaction.state === "replaced"))) return false;
  // An approval receipt cannot settle a separately recorded, hash-lost swap.
  // stopped-after-approval is distinct: it requires the adapter's no-send proof.
  if (["approval-reverted", "approval-replaced"].includes(record.stage) && active.schema !== "realdex.v01-active-operation.v1" && active.attempts.some(attempt => attempt.role === "swap")) return false;
  const terminal = record.transactions.find(transaction => transaction.role === (record.stage.startsWith("swap-") ? "swap" : "approval"));
  return !!terminal && terminal.confirmations !== null && terminal.confirmations >= Math.max(2, record.requiredConfirmations);
}
