import { describe, expect, it } from "vitest";
import { friendlyError, minimumReceived, normalizeAddress, parsePositiveAmount } from "./lib";

describe("transaction safety helpers", () => {
  it("calculates minimum received with integer floor arithmetic", () => {
    expect(minimumReceived(101n, 50)).toBe(100n);
    expect(minimumReceived(0n, 0)).toBe(0n);
    expect(minimumReceived(101n, 0)).toBe(101n);
    expect(minimumReceived(1n, 50)).toBe(0n);
    expect(minimumReceived(100n, 5_000)).toBe(50n);
    expect(minimumReceived(1_000_000n, 50)).toBe(995_000n);
  });

  it("rejects invalid minimum received slippage", () => {
    expect(() => minimumReceived(100n, -1)).toThrow();
    expect(() => minimumReceived(100n, 5_001)).toThrow();
    expect(() => minimumReceived(100n, 12.5)).toThrow();
    expect(() => minimumReceived(100n, Number.NaN)).toThrow();
    expect(() => minimumReceived(100n, Number.POSITIVE_INFINITY)).toThrow();
  });

  it("parses the smallest 18-decimal positive amount exactly", () => {
    expect(parsePositiveAmount("0.000000000000000001", 18)).toBe(1n);
  });

  it("preserves exact large integer amounts beyond the JavaScript safe integer range", () => {
    expect(parsePositiveAmount("9007199254740993", 0)).toBe(9_007_199_254_740_993n);
    expect(parsePositiveAmount("9007199254740993.000000000000000001", 18)).toBe(9_007_199_254_740_993_000_000_000_000_000_001n);
  });

  it("rejects empty, whitespace, zero, negative, malformed, and exponent values", () => {
    expect(parsePositiveAmount("1.25", 6)).toBe(1_250_000n);
    expect(() => parsePositiveAmount("", 18)).toThrow();
    expect(() => parsePositiveAmount("   ", 18)).toThrow();
    expect(() => parsePositiveAmount("0", 18)).toThrow();
    expect(() => parsePositiveAmount("-1", 18)).toThrow();
    expect(() => parsePositiveAmount("1..0", 18)).toThrow();
    expect(() => parsePositiveAmount("1e3", 18)).toThrow();
    expect(() => parsePositiveAmount("0.0000000000000000011", 18)).toThrow();
    expect(() => normalizeAddress("0x1234")).toThrow();
  });

  it("does not present a wallet rejection as a chain failure", () => {
    expect(friendlyError(new Error("ACTION_REJECTED"))).toContain("拒否");
    expect(friendlyError(new Error("SlippageExceeded"))).toContain("価格");
  });

  it("explains quote invalidation and duplicate guards without hiding the safety stop", () => {
    expect(friendlyError(new Error("ROUTE_SLIPPAGE_OUT_OF_RANGE"))).toContain("スリッページ");
    expect(friendlyError(new Error("WALLET_ACCOUNT_CHANGED"))).toContain("アカウント");
    expect(friendlyError(new Error("WALLET_NETWORK_CHANGED"))).toContain("ネットワーク");
    expect(friendlyError(new Error("LOCAL_AMM_POOL_PAIR_CHANGED"))).toContain("トークン構成");
    expect(friendlyError(new Error("EVM_VENUE_FACTORY_CODE_MISMATCH"))).toContain("bytecode");
    expect(friendlyError(new Error("EVM_VENUE_POOL_FACTORY_MISMATCH"))).toContain("作成元");
    expect(friendlyError(new Error("EXECUTION_GUARD_PERSISTENCE_UNAVAILABLE"))).toContain("送信前に停止");
    expect(friendlyError(new Error("EXECUTION_GUARD_CROSS_TAB_LOCK_UNAVAILABLE"))).toContain("複数タブ間");
    expect(friendlyError(new Error("DUPLICATE_ROUTE_EXECUTION"))).toContain("送信済み");
  });
});
