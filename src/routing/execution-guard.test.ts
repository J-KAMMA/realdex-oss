import { describe, expect, it } from "vitest";
import { assertRouteExecutionGuardRecord, clearRouteExecutionGuard, createRouteExecutionGuardRecord, legacyQuoteExecutionGuardKey, legacyRouteExecutionGuardExists, persistRouteExecutionGuard, persistentExecutionGuardExists, routeExecutionGuardKey, type ExecutionGuardStorage } from "./execution-guard";

const routeFingerprint = `0x${"1".repeat(64)}`;
const requestFingerprint = `0x${"2".repeat(64)}`;
const quoteId = "quote:exact:1";
const executionIntentId = "realdex-intent:v1:00010203-0405-4607-8809-0a0b0c0d0e0f";

function memoryStorage(): ExecutionGuardStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
}

describe("persistent route execution guard", () => {
  it("persists and reads back an exact non-expiring authority lock", () => {
    const storage = memoryStorage();
    const record = createRouteExecutionGuardRecord(routeFingerprint, executionIntentId, requestFingerprint, quoteId, 1_800_000_000_000);
    persistRouteExecutionGuard(storage, record);
    expect(JSON.parse(storage.getItem(record.guardKey)!)).toEqual(record);
    expect(persistentExecutionGuardExists(storage, record.guardKey)).toBe(true);
    expect(() => assertRouteExecutionGuardRecord(record, record.guardKey)).not.toThrow();
    expect(record).not.toHaveProperty("expiresAt");
  });

  it("keeps even an expired legacy guard fail-closed", () => {
    const storage = memoryStorage();
    const key = legacyQuoteExecutionGuardKey(routeFingerprint, requestFingerprint, quoteId);
    storage.setItem(key, JSON.stringify({ state: "submitted-or-unknown", expiresAt: 1 }));
    expect(persistentExecutionGuardExists(storage, key)).toBe(true);
    expect(storage.getItem(key)).not.toBeNull();
  });

  it("detects opaque pre-intent guards by route without trusting their old expiry or request hash", () => {
    const storage = memoryStorage();
    storage.setItem(`localswap:route-execution:${routeFingerprint}:fnv1a:12345678:old-quote`, JSON.stringify({ state: "submitted-or-unknown", expiresAt: 1 }));
    const enumerable = { ...storage, get length() { return storage.values.size; }, key: (index: number) => [...storage.values.keys()][index] ?? null };
    expect(legacyRouteExecutionGuardExists(enumerable, routeFingerprint)).toBe(true);
    expect(legacyRouteExecutionGuardExists(enumerable, `0x${"3".repeat(64)}`)).toBe(false);
  });

  it("blocks malformed or modified stored records instead of deleting them", () => {
    const storage = memoryStorage();
    const record = createRouteExecutionGuardRecord(routeFingerprint, executionIntentId, requestFingerprint, quoteId, 1_800_000_000_000);
    storage.setItem(record.guardKey, JSON.stringify({ ...record, quoteId: "quote:changed" }));
    expect(persistentExecutionGuardExists(storage, record.guardKey)).toBe(true);
    expect(storage.getItem(record.guardKey)).not.toBeNull();
  });

  it("fails before execution authority when durable write or readback fails", () => {
    const record = createRouteExecutionGuardRecord(routeFingerprint, executionIntentId, requestFingerprint, quoteId, 1_800_000_000_000);
    const throwing = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined };
    expect(() => persistRouteExecutionGuard(throwing, record)).toThrow("EXECUTION_GUARD_PERSISTENCE_UNAVAILABLE");
    const noReadback = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    expect(() => persistRouteExecutionGuard(noReadback, record)).toThrow("EXECUTION_GUARD_PERSISTENCE_UNAVAILABLE");
  });

  it("clears only when storage proves absence and rejects unsafe quote IDs", () => {
    const storage = memoryStorage();
    const record = createRouteExecutionGuardRecord(routeFingerprint, executionIntentId, requestFingerprint, quoteId, 1_800_000_000_000);
    persistRouteExecutionGuard(storage, record);
    expect(clearRouteExecutionGuard(storage, record.guardKey)).toBe(true);
    expect(persistentExecutionGuardExists(storage, record.guardKey)).toBe(false);
    expect(() => legacyQuoteExecutionGuardKey(routeFingerprint, requestFingerprint, " bad ")).toThrow("QUOTE_ID_INVALID");
    expect(() => legacyQuoteExecutionGuardKey(routeFingerprint, requestFingerprint, "x".repeat(801))).toThrow("QUOTE_ID_INVALID");
    expect(routeExecutionGuardKey(routeFingerprint, executionIntentId)).toBe(record.guardKey);
  });
});
