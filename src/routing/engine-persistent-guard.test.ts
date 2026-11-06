/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderBindingGrant } from "../wallet/capabilities";
import { executeRouteQuote, executionGuardKey, routeDescriptorFingerprint, routeRequestFingerprint } from "./engine";
import { legacyQuoteExecutionGuardKey } from "./execution-guard";
import type { CrossTabExecutionLockManager } from "./cross-tab-execution-lock";
import type { RouteDescriptor, RouteQuote, RouteQuoteRequest, UniversalRouteAdapter } from "./types";

const source = "eip155:31337/erc20:0x1111111111111111111111111111111111111111";
const destination = "eip155:31337/erc20:0x2222222222222222222222222222222222222222";
const account = "0x3333333333333333333333333333333333333333";
const target = "0x4444444444444444444444444444444444444444";
const route: RouteDescriptor = {
  id: "persistent-guard-route", revision: 1, operation: "swap", adapterId: "persistent-guard-test", sourceAsset: source, destinationAsset: destination,
  state: "ready", walletCapabilityIds: ["eip1193"], sourceExecutionTarget: target, executionMethod: "swapExactIn", maximumQuoteTtlMs: 120_000,
  finalityTracking: "tracked", trustBoundary: "test only", evidenceUrls: ["https://example.invalid/guard"]
};
let intentSequence = 100;

function fixture(suffix: string) {
  const now = Date.now();
  const accountId = `eip155:31337:${account}`;
  const request: RouteQuoteRequest = {
    executionIntentId: `realdex-intent:v1:00000000-0000-4000-8000-${(++intentSequence).toString(16).padStart(12, "0")}`,
    sourceAsset: source, destinationAsset: destination, amountInBaseUnits: 1_000_000n, accountId, recipient: account, walletCapabilityId: "eip1193",
    sessionRevision: 1, walletGrant: createProviderBindingGrant({ transportId: `test:${suffix}`, accountId, walletCapabilityId: "eip1193", sessionRevision: 1, expiresAt: now + 120_000 }), slippageBps: 50
  };
  const quote: RouteQuote = {
    quoteId: `quote:${suffix}`, routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route), requestFingerprint: routeRequestFingerprint(request), adapterId: route.adapterId,
    amountInBaseUnits: request.amountInBaseUnits, expectedOutBaseUnits: 900_000n, minimumOutBaseUnits: 895_500n, fees: [], unpricedCosts: [], expiresAt: now + 60_000,
    estimatedSeconds: null, authorization: { type: "none" }, executionPreview: { chainId: "eip155:31337", target, method: "swapExactIn", valueBaseUnits: 0n }, adapterData: { format: "test.v1", value: {} }
  };
  return { now, request, quote };
}

function adapter(execute: UniversalRouteAdapter["execute"]): UniversalRouteAdapter {
  return { adapterId: route.adapterId, supports: (candidate) => candidate.id === route.id, quote: async () => { throw new Error("unused"); }, connectAccount: async () => `eip155:31337:${account}`, execute };
}

const availableLockManager: CrossTabExecutionLockManager = { request: async (_name, _options, callback) => callback({ mode: "exclusive" }) };

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", { configurable: true, value: availableLockManager });
});

describe("route execution durable guard integration", () => {
  it("stops before account connection when origin-wide locking is unavailable", async () => {
    const { now, request, quote } = fixture("lock-unavailable");
    const connectAccount = vi.fn(async () => `eip155:31337:${account}`);
    const execute = vi.fn(async () => ({ executionId: "never", quoteId: quote.quoteId, state: "confirmed" as const, provider: "test", steps: [] }));
    const selected = { ...adapter(execute), connectAccount };
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    await expect(executeRouteQuote(route, request, quote, [selected], now)).rejects.toThrow("EXECUTION_GUARD_CROSS_TAB_LOCK_UNAVAILABLE");
    expect(connectAccount).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops before adapter execution when durable storage cannot be written", async () => {
    const { now, request, quote } = fixture("write-failure");
    const execute = vi.fn(async () => ({ executionId: "never", quoteId: quote.quoteId, state: "confirmed" as const, provider: "test", steps: [] }));
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("quota"); });
    await expect(executeRouteQuote(route, request, quote, [adapter(execute)], now)).rejects.toThrow("EXECUTION_GUARD_PERSISTENCE_UNAVAILABLE");
    expect(execute).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("does not create adapter preparation state when account connection fails", async () => {
    const { now, request, quote } = fixture("connect-rejected");
    const prepare = vi.fn();
    const execute = vi.fn(async () => ({ executionId: "never", quoteId: quote.quoteId, state: "confirmed" as const, provider: "test", steps: [] }));
    const selected = { ...adapter(execute), connectAccount: vi.fn(async () => { throw new Error("WALLET_CONNECTION_REJECTED"); }) };
    await expect(executeRouteQuote(route, request, quote, [selected], now, undefined, prepare)).rejects.toThrow("WALLET_CONNECTION_REJECTED");
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(localStorage.getItem(executionGuardKey(route, request))).toBeNull();
  });

  it("prepares recovery state only after the durable guard and immediately before the adapter", async () => {
    const { now, request, quote } = fixture("prepare-order");
    const order: string[] = [];
    const prepare = vi.fn(() => {
      expect(localStorage.getItem(executionGuardKey(route, request))).not.toBeNull();
      order.push("prepare");
    });
    const execute = vi.fn(async () => {
      order.push("execute");
      return { executionId: "attempt:prepared", quoteId: quote.quoteId, state: "confirmed" as const, provider: "test", steps: [] };
    });
    await executeRouteQuote(route, request, quote, [adapter(execute)], now, undefined, prepare);
    expect(order).toEqual(["prepare", "execute"]);
  });

  it("releases the guard and never calls the adapter when preparation fails", async () => {
    const { now, request, quote } = fixture("prepare-failed");
    const execute = vi.fn(async () => ({ executionId: "never", quoteId: quote.quoteId, state: "confirmed" as const, provider: "test", steps: [] }));
    const prepare = vi.fn(() => { throw new Error("FINALITY_STORAGE_PERSIST_FAILED"); });
    await expect(executeRouteQuote(route, request, quote, [adapter(execute)], now, undefined, prepare)).rejects.toThrow("FINALITY_STORAGE_PERSIST_FAILED");
    expect(execute).not.toHaveBeenCalled();
    expect(localStorage.getItem(executionGuardKey(route, request))).toBeNull();
  });

  it("does not expire a legacy unknown guard merely because its old timestamp passed", async () => {
    const { now, request, quote } = fixture("legacy-expired");
    const execute = vi.fn(async () => ({ executionId: "never", quoteId: quote.quoteId, state: "confirmed" as const, provider: "test", steps: [] }));
    localStorage.setItem(legacyQuoteExecutionGuardKey(routeDescriptorFingerprint(route), quote.requestFingerprint, quote.quoteId), JSON.stringify({ state: "submitted-or-unknown", expiresAt: 1 }));
    await expect(executeRouteQuote(route, request, quote, [adapter(execute)], now)).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
    expect(execute).not.toHaveBeenCalled();
  });

  it("clears the durable guard only after an explicit failed receipt", async () => {
    const { now, request, quote } = fixture("explicit-failure");
    let calls = 0;
    const execute = vi.fn(async () => ({ executionId: `attempt:${++calls}`, quoteId: quote.quoteId, state: calls === 1 ? "failed" as const : "confirmed" as const, provider: "test", steps: [{ name: "Swap", state: calls === 1 ? "failed" : "confirmed" }], failureProof: calls === 1 ? { type: "no-value-transfer-submitted" as const } : undefined }));
    const selected = adapter(execute);
    expect((await executeRouteQuote(route, request, quote, [selected], now)).state).toBe("failed");
    expect(localStorage.getItem(executionGuardKey(route, request))).toBeNull();
    expect((await executeRouteQuote(route, request, quote, [selected], now)).state).toBe("confirmed");
    expect(localStorage.getItem(executionGuardKey(route, request))).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("retains the durable guard when failed is ambiguous even if the adapter exposes a transaction hash", async () => {
    const { now, request, quote } = fixture("ambiguous-failure");
    const execute = vi.fn(async () => ({ executionId: "attempt:ambiguous", quoteId: quote.quoteId, state: "failed" as const, provider: "test", steps: [{ name: "Swap", state: "failed", kind: "swap" as const, txHash: `0x${"a".repeat(64)}` }] }));
    const selected = adapter(execute);
    expect((await executeRouteQuote(route, request, quote, [selected], now)).state).toBe("failed");
    expect(localStorage.getItem(executionGuardKey(route, request))).not.toBeNull();
    await expect(executeRouteQuote(route, request, quote, [selected], now)).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a false no-submission proof when a swap transaction identity exists", async () => {
    const { now, request, quote } = fixture("false-no-submission");
    const execute = vi.fn(async () => ({ executionId: "attempt:false-proof", quoteId: quote.quoteId, state: "failed" as const, provider: "test", steps: [{ name: "Swap", state: "failed", kind: "swap" as const, txHash: `0x${"b".repeat(64)}` }], failureProof: { type: "no-value-transfer-submitted" as const } }));
    expect((await executeRouteQuote(route, request, quote, [adapter(execute)], now)).state).toBe("failed");
    expect(localStorage.getItem(executionGuardKey(route, request))).not.toBeNull();
  });

  it("allows a retry only after an exactly evidenced reverted EVM value-transfer transaction", async () => {
    const { now, request, quote } = fixture("reverted-swap");
    const txHash = `0x${"c".repeat(64)}`;
    const blockHash = `0x${"d".repeat(64)}`;
    const execute = vi.fn(async () => ({
      executionId: "attempt:reverted", quoteId: quote.quoteId, state: "failed" as const, provider: "test",
      steps: [{ name: "Swap", state: "reverted", kind: "swap" as const, txHash, evmTransaction: { from: account, to: target, nonce: 7, data: "0x1234", valueBaseUnits: "0", chainId: "31337", observedBeforeBlock: 90 }, evmReceipt: { hash: txHash, status: 0 as const, blockNumber: 91, blockHash } }],
      failureProof: { type: "evm-value-transfer-reverted" as const, transactionHash: txHash }
    }));
    const selected = adapter(execute);
    expect((await executeRouteQuote(route, request, quote, [selected], now)).state).toBe("failed");
    expect(localStorage.getItem(executionGuardKey(route, request))).toBeNull();
    expect((await executeRouteQuote(route, request, quote, [selected], now)).state).toBe("failed");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("validates progress before exposing it and retains the guard on a false terminal update", async () => {
    const { now, request, quote } = fixture("progress-validation");
    const exposed = vi.fn();
    const execute = vi.fn(async (_route, _request, _quote, progress) => {
      progress?.({ executionId: "progress:1", quoteId: quote.quoteId, state: "failed", provider: "test", steps: [{ name: "Swap", state: "failed" }], failureProof: { type: "no-value-transfer-submitted" } });
      return { executionId: "never", quoteId: quote.quoteId, state: "confirmed" as const, provider: "test", steps: [] };
    });
    await expect(executeRouteQuote(route, request, quote, [adapter(execute)], now, exposed)).rejects.toThrow("EXECUTION_PROGRESS_STATE_INVALID");
    expect(exposed).not.toHaveBeenCalled();
    expect(localStorage.getItem(executionGuardKey(route, request))).not.toBeNull();
  });

  it("blocks a refreshed quote and wallet grant that reuse the same human execution intent", async () => {
    const { now, request, quote } = fixture("intent-requote");
    const execute = vi.fn(async (_route, _request, selectedQuote: RouteQuote) => ({ executionId: `attempt:${selectedQuote.quoteId}`, quoteId: selectedQuote.quoteId, state: "confirmed" as const, provider: "test", steps: [{ name: "Swap", state: "confirmed" }] }));
    const selected = adapter(execute);
    await executeRouteQuote(route, request, quote, [selected], now);
    const refreshedRequest = { ...request, walletGrant: { ...request.walletGrant, expiresAt: request.walletGrant.expiresAt + 1_000 } };
    const refreshedQuote = { ...quote, quoteId: `${quote.quoteId}:refreshed`, requestFingerprint: routeRequestFingerprint(refreshedRequest), expiresAt: quote.expiresAt + 1_000 };
    await expect(executeRouteQuote(route, refreshedRequest, refreshedQuote, [selected], now)).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
