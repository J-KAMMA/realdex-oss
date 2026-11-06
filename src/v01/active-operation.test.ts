/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Interface } from "ethers";
import { ERC20_ABI, POOL_ABI } from "../abi";
import { canCloseV01Operation, clearActiveV01Operation, readActiveV01Operation, saveActiveV01Operation, persistV01SendAttempt, withV01OperationLock, type ActiveV01Operation } from "./active-operation";
import type { EvmSwapRecoveryRecord } from "../swap/evm-swap-recovery";
import { evmSwapRecoveryIdentity } from "../swap/evm-swap-recovery";
import type { V01SendAttempt } from "./send-attempt";
import type { V01RecoveryIntent } from "./recovery-intent";

const attempt = (): ActiveV01Operation => ({ schema: "realdex.v01-active-operation.v1", intentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000001", quoteId: "test-quote", profileFingerprint: `0x${"a".repeat(64)}`, recoveryId: null });
beforeEach(() => { localStorage.clear(); Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }); });
const prepared = (): Extract<ActiveV01Operation, { schema: "realdex.v01-active-operation.v2" }> => ({ ...attempt(), schema: "realdex.v01-active-operation.v2", attempts: [] });
const send = (role: "approval" | "swap" = "approval"): V01SendAttempt => ({
  intentId: attempt().intentId, quoteId: attempt().quoteId, profileFingerprint: attempt().profileFingerprint, role, observedBeforeBlock: 10,
  transaction: { from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, data: `0x${"a".repeat(role === "approval" ? 136 : 328)}`, value: "0x0", chainId: "0x14a34", type: "0x2", nonce: role === "approval" ? "0x1" : "0x2", gas: "0x186a0", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1" }
});

function recovery(approvalRequired = true): V01RecoveryIntent {
  const recipient = `0x${"1".repeat(40)}`;
  const routeFingerprint = `0x${"c".repeat(64)}`;
  const requestFingerprint = `0x${"d".repeat(64)}`;
  const quoteId = "test-quote";
  return {
    schema: "realdex.v01-recovery-intent.v1", intentId: attempt().intentId, profileFingerprint: attempt().profileFingerprint,
    recoveryId: evmSwapRecoveryIdentity(routeFingerprint, requestFingerprint, quoteId), routeId: "test-route", routeFingerprint, quoteId, requestFingerprint,
    accountId: `eip155:84532:${recipient}`, recipient, sourceAsset: `eip155:84532/erc20:0x${"2".repeat(40)}`, destinationAsset: `eip155:84532/erc20:0x${"3".repeat(40)}`,
    amountInBaseUnits: "1000", minimumOutBaseUnits: "890", poolAddress: `0x${"4".repeat(40)}`, quoteExpiresAt: 1_700_000_120_000,
    approvalRequired, capturedAt: 1_700_000_000_000
  };
}

function v3Attempt(value: ReturnType<typeof recovery>, role: "approval" | "swap", nonce: number): V01SendAttempt {
  const source = `0x${"2".repeat(40)}`;
  const data = role === "approval"
    ? new Interface(ERC20_ABI).encodeFunctionData("approve", [value.poolAddress, value.amountInBaseUnits])
    : new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [source, value.amountInBaseUnits, value.minimumOutBaseUnits, value.recipient, Math.floor(value.quoteExpiresAt / 1000)]);
  return {
    intentId: value.intentId, quoteId: value.quoteId, profileFingerprint: value.profileFingerprint, role, observedBeforeBlock: 10,
    transaction: { from: value.recipient, to: role === "approval" ? source : value.poolAddress, data, value: "0x0", chainId: "0x14a34", type: "0x2", nonce: `0x${nonce.toString(16)}`, gas: "0x186a0", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1" }
  };
}

function v3(value = recovery(), attempts: V01SendAttempt[] = [], recoveryId: string | null = null): Extract<ActiveV01Operation, { schema: "realdex.v01-active-operation.v3" }> {
  return { schema: "realdex.v01-active-operation.v3", intentId: value.intentId, quoteId: value.quoteId, profileFingerprint: value.profileFingerprint, recoveryId, attempts, recovery: value };
}
describe("v0.1 cross-quote operation guard", () => {
  it("durably records exact pre-wallet attempts, preserves them when adding a recovery ID and rejects stale writes", () => {
    const initial = prepared(); saveActiveV01Operation(initial);
    expect(persistV01SendAttempt(send())).toBe(true);
    expect(persistV01SendAttempt(send("swap"))).toBe(true);
    const current = readActiveV01Operation()!;
    expect(current).toEqual({ ...initial, attempts: [send(), send("swap")] });
    saveActiveV01Operation({ ...current, recoveryId: "recovery" });
    expect(readActiveV01Operation()).toEqual({ ...current, recoveryId: "recovery" });
    expect(() => saveActiveV01Operation({ ...initial, recoveryId: "recovery" })).toThrow("V01_SEND_ATTEMPT_CHANGED");
    const modified = { ...current, recoveryId: "recovery", schema: "realdex.v01-active-operation.v2" as const, attempts: [send(), { ...send("swap"), observedBeforeBlock: 11 }] };
    expect(() => saveActiveV01Operation(modified)).toThrow("V01_SEND_ATTEMPT_CHANGED");
  });
  it("requires the exact durable operation binding before recording a request", () => {
    expect(() => persistV01SendAttempt(send())).toThrow("V01_SEND_ATTEMPT_BINDING_MISMATCH");
    saveActiveV01Operation(prepared());
    for (const change of [{ quoteId: "other" }, { intentId: attempt().intentId.replace(/1$/, "2") }, { profileFingerprint: `0x${"b".repeat(64)}` }]) {
      expect(() => persistV01SendAttempt({ ...send(), ...change })).toThrow("V01_SEND_ATTEMPT_BINDING_MISMATCH");
    }
    expect(readActiveV01Operation()).toEqual(prepared());
  });
  it("keeps legacy unresolved operations readable without fabricating pre-send evidence or changing schema", () => {
    saveActiveV01Operation(attempt());
    expect(() => persistV01SendAttempt(send())).toThrow("V01_SEND_ATTEMPT_BINDING_MISMATCH");
    expect(() => saveActiveV01Operation(prepared())).toThrow("V01_SEND_ATTEMPT_CHANGED");
    expect(readActiveV01Operation()).toEqual(attempt());
  });
  it("rejects duplicate roles, reversed order, mismatched nonces and account changes", () => {
    for (const attempts of [
      [send(), send()], [send("swap"), send()],
      [send(), { ...send("swap"), transaction: { ...send("swap").transaction, nonce: "0x5" } }],
      [send(), { ...send("swap"), transaction: { ...send("swap").transaction, from: `0x${"3".repeat(40)}` } }],
      [send(), { ...send("swap"), observedBeforeBlock: 9 }],
      [send(), send("swap"), send("swap")]
    ]) expect(() => saveActiveV01Operation({ ...prepared(), attempts })).toThrow();
    expect(readActiveV01Operation()).toBeNull();
    saveActiveV01Operation({ ...prepared(), attempts: [send("swap")] });
    expect(readActiveV01Operation()).toEqual({ ...prepared(), attempts: [send("swap")] });
  });
  it("rejects malformed or unbounded transaction evidence before storage mutation", () => {
    for (const change of [{ chainId: "0x1" }, { value: "0x1" }, { data: "0x" }, { nonce: "0x01" }, { nonce: "0x20000000000000" }, { gas: "0x0" }, { maxFeePerGas: "0x0" }, { maxPriorityFeePerGas: "0x3" }, { accessList: [] }]) {
      expect(() => saveActiveV01Operation({ ...prepared(), attempts: [{ ...send(), transaction: { ...send().transaction, ...change } }] })).toThrow("V01_SEND_ATTEMPT_INVALID");
    }
    for (const observedBeforeBlock of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1]) expect(() => saveActiveV01Operation({ ...prepared(), attempts: [{ ...send(), observedBeforeBlock }] })).toThrow("V01_SEND_ATTEMPT_INVALID");
    expect(readActiveV01Operation()).toBeNull();
  });
  it("never acknowledges a dropped, modified or throwing write", () => {
    saveActiveV01Operation(prepared());
    const original = Storage.prototype.setItem;
    for (const behavior of ["drop", "modify", "throw"]) {
      const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (behavior === "throw") throw new Error("STORAGE_FAILURE");
        if (behavior === "modify") original.call(this, key, value + " ");
      });
      expect(() => persistV01SendAttempt(send())).toThrow();
      spy.mockRestore(); localStorage.clear(); saveActiveV01Operation(prepared());
    }
  });
  it("retains a hashless attempt across reads and refuses another intent or profile", () => {
    const initial = attempt(); saveActiveV01Operation(initial);
    expect(readActiveV01Operation()).toEqual(initial);
    expect(() => saveActiveV01Operation({ ...initial, intentId: initial.intentId.replace(/1$/, "2") })).toThrow("V01_UNRESOLVED_OPERATION");
    expect(() => saveActiveV01Operation({ ...initial, profileFingerprint: `0x${"b".repeat(64)}` })).toThrow("V01_UNRESOLVED_OPERATION");
    saveActiveV01Operation({ ...initial, recoveryId: "recovery-a" });
    expect(() => saveActiveV01Operation(initial)).toThrow("V01_UNRESOLVED_OPERATION");
    expect(() => saveActiveV01Operation({ ...initial, recoveryId: "recovery-b" })).toThrow("V01_UNRESOLVED_OPERATION");
  });
  it("fails closed on malformed durable state and only clears the matching operation", () => {
    localStorage.setItem("realdex:v01-active-operation:v1", "{}");
    expect(() => readActiveV01Operation()).toThrow("V01_ACTIVE_OPERATION_INVALID");
    expect(() => saveActiveV01Operation(attempt())).toThrow();
    localStorage.clear(); saveActiveV01Operation(attempt());
    expect(() => clearActiveV01Operation({ ...attempt(), quoteId: "other" })).toThrow("V01_ACTIVE_OPERATION_CHANGED");
    clearActiveV01Operation(attempt()); expect(readActiveV01Operation()).toBeNull();
  });
  it("does not offer closing for unknown, pending, inclusion-only or mismatched history", () => {
    const current = { ...attempt(), recoveryId: "recovery" };
    for (const stage of ["unknown", "swap-included", "swap-submitted", "approval-confirmed", "approval-submitted", "replacement-searching", "swap-replaced"]) {
      expect(canCloseV01Operation(current, { recoveryId: "recovery", quoteId: current.quoteId, stage } as EvmSwapRecoveryRecord)).toBe(false);
    }
    expect(canCloseV01Operation(current, { recoveryId: "recovery", quoteId: current.quoteId, stage: "swap-confirmed", requiredConfirmations: 2, transactions: [{ role: "swap", confirmations: 2 }] } as EvmSwapRecoveryRecord)).toBe(true);
    expect(canCloseV01Operation(current, { recoveryId: "recovery", quoteId: current.quoteId, stage: "swap-reverted", requiredConfirmations: 2, transactions: [{ role: "swap", confirmations: 1 }] } as EvmSwapRecoveryRecord)).toBe(false);
    expect(canCloseV01Operation(current, { recoveryId: "other", quoteId: current.quoteId, stage: "swap-confirmed" } as EvmSwapRecoveryRecord)).toBe(false);
  });
  it("requires the global Web Lock before entering and rejects contention", async () => {
    const action = vi.fn(async () => 42);
    await expect(withV01OperationLock(action)).rejects.toThrow("EXECUTION_GUARD_CROSS_TAB_LOCK_UNAVAILABLE");
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback(null)) } });
    await expect(withV01OperationLock(action)).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
    expect(action).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn(async (name, options, callback) => { expect(name).toMatch(/^realdex:route-execution:/); expect(options).toEqual({ mode: "exclusive", ifAvailable: true }); return callback({}); }) } });
    await expect(withV01OperationLock(action)).resolves.toBe(42);
  });

  it("does not close a recorded swap attempt using only a reverted approval", () => {
    const value = recovery();
    const operation = v3(value, [v3Attempt(value, "approval", 1), v3Attempt(value, "swap", 2)], value.recoveryId);
    const record = { recoveryId: value.recoveryId, quoteId: value.quoteId, stage: "approval-reverted", requiredConfirmations: 2, transactions: [{ role: "approval", confirmations: 3 }] } as EvmSwapRecoveryRecord;
    expect(canCloseV01Operation(operation, record)).toBe(false);
    expect(canCloseV01Operation({ ...operation, attempts: [operation.attempts[0]] }, record)).toBe(true);
    expect(canCloseV01Operation(operation, { ...record, stage: "stopped-after-approval" })).toBe(true);
  });

  it("offers replacement close only for v3 evidence and never uses approval replacement to resolve a saved swap", () => {
    const value = recovery();
    const operation = v3(value, [v3Attempt(value, "approval", 1), v3Attempt(value, "swap", 2)], value.recoveryId);
    const record = { recoveryId: value.recoveryId, quoteId: value.quoteId, stage: "approval-replaced", requiredConfirmations: 2, transactions: [{ role: "approval", state: "replaced", confirmations: 3, envelope: { replacement: { reason: "cancelled" } } }] } as EvmSwapRecoveryRecord;
    expect(canCloseV01Operation(operation, record)).toBe(false);
    expect(canCloseV01Operation({ ...operation, attempts: [operation.attempts[0]] }, record)).toBe(true);
    expect(canCloseV01Operation({ ...attempt(), recoveryId: value.recoveryId }, record)).toBe(false);
    const swap = { ...record, stage: "swap-replaced", transactions: [{ ...record.transactions[0], role: "swap" }] } as EvmSwapRecoveryRecord;
    expect(canCloseV01Operation(operation, swap)).toBe(true);
    expect(canCloseV01Operation(operation, { ...swap, transactions: [{ ...swap.transactions[0], confirmations: 1 }] })).toBe(false);
    expect(canCloseV01Operation(operation, { ...swap, transactions: [{ ...swap.transactions[0], envelope: undefined }] })).toBe(false);
  });

  it("preserves v3 recovery metadata while appending attempts and binding the receipt recovery ID", () => {
    const value = recovery();
    saveActiveV01Operation(v3(value));
    const approval = v3Attempt(value, "approval", 1), swap = v3Attempt(value, "swap", 2);
    expect(persistV01SendAttempt(approval)).toBe(true);
    expect(persistV01SendAttempt(swap)).toBe(true);
    const recorded = readActiveV01Operation();
    if (recorded?.schema !== "realdex.v01-active-operation.v3") throw new Error("Expected persisted v3 operation");
    saveActiveV01Operation({ ...recorded, recoveryId: value.recoveryId });
    expect(readActiveV01Operation()).toEqual({ ...recorded, recoveryId: value.recoveryId });
    expect(() => saveActiveV01Operation({ ...recorded, recoveryId: value.recoveryId, recovery: { ...value, capturedAt: value.capturedAt - 1 } })).toThrow("V01_RECOVERY_INTENT_CHANGED");
  });

  it("rejects v3 context mismatches, recovery downgrades, and upgrading an old v2 operation", () => {
    const value = recovery();
    expect(() => saveActiveV01Operation({ ...v3(value), intentId: value.intentId.replace(/1$/, "2") })).toThrow("V01_RECOVERY_INTENT_BINDING_MISMATCH");
    expect(() => saveActiveV01Operation({ ...v3(value), quoteId: "other" })).toThrow("V01_RECOVERY_INTENT_BINDING_MISMATCH");
    expect(() => saveActiveV01Operation({ ...v3(value), recoveryId: `0x${"f".repeat(64)}` })).toThrow("V01_RECOVERY_INTENT_BINDING_MISMATCH");
    saveActiveV01Operation(v3(value));
    const { recovery: _omittedRecovery, ...v3WithoutRecovery } = v3(value);
    expect(() => saveActiveV01Operation({ ...v3WithoutRecovery, schema: "realdex.v01-active-operation.v2", attempts: [] })).toThrow("V01_SEND_ATTEMPT_CHANGED");
    localStorage.clear();
    saveActiveV01Operation(prepared());
    expect(() => saveActiveV01Operation(v3(value))).toThrow("V01_SEND_ATTEMPT_CHANGED");
  });

  it("supports approval plus swap, and a no-approval swap-only operation", () => {
    const approvalValue = recovery(true);
    saveActiveV01Operation(v3(approvalValue));
    expect(() => persistV01SendAttempt(v3Attempt(approvalValue, "swap", 1))).toThrow("V01_SEND_ATTEMPT_SEQUENCE_INVALID");
    expect(readActiveV01Operation()).toEqual(v3(approvalValue));
    expect(() => persistV01SendAttempt(v3Attempt(approvalValue, "approval", 1))).not.toThrow();
    expect(() => persistV01SendAttempt(v3Attempt(approvalValue, "swap", 2))).not.toThrow();
    localStorage.clear();
    const swapValue = recovery(false);
    saveActiveV01Operation(v3(swapValue));
    expect(() => persistV01SendAttempt(v3Attempt(swapValue, "approval", 1))).toThrow("V01_RECOVERY_ATTEMPT_MISMATCH");
    expect(readActiveV01Operation()).toEqual(v3(swapValue));
    expect(() => persistV01SendAttempt(v3Attempt(swapValue, "swap", 1))).not.toThrow();
    expect(readActiveV01Operation()).toEqual(v3(swapValue, [v3Attempt(swapValue, "swap", 1)]));
  });
});
