import { describe, expect, it } from "vitest";
import { routeDescriptorFingerprint } from "./engine";
import { findRoutePlans } from "./plan";
import {
  assertRoutePlanProgressRecord, createRoutePlanProgressRecord, persistRoutePlanProgress,
  readRoutePlanProgress, routePlanAssetsInOrder, routePlanProgressKey, routePlanProgressMatchesPlan,
  routePlanState, routePlanStateFromRecord, type RoutePlanLegOutcome
} from "./plan-progress";
import type { ExecutionGuardStorage } from "./execution-guard";
import type { RouteDescriptor, RouteExecutionReceipt, RouteFinalityStage } from "./types";

const AMBER = "eip155:84532/erc20:0xa7aD1A578C2758D761F8DB4D1C8220b3fCcf4996";
const BASE_USDC = "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ARBITRUM_USDC = "eip155:421614/erc20:0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

function descriptor(overrides: Partial<RouteDescriptor> & Pick<RouteDescriptor, "id" | "sourceAsset" | "destinationAsset">): RouteDescriptor {
  return {
    revision: 1, operation: "swap", adapterId: "mock", state: "ready", walletCapabilityIds: ["eip1193"],
    sourceExecutionTarget: "0x4444444444444444444444444444444444444444", executionMethod: "swapExactIn",
    maximumQuoteTtlMs: 120_000, finalityTracking: "tracked", trustBoundary: "test adapter",
    evidenceUrls: ["https://example.invalid/evidence"], ...overrides
  };
}

const swapLeg = descriptor({ id: "swap-amber-usdc", sourceAsset: AMBER, destinationAsset: BASE_USDC });
const bridgeLeg = descriptor({
  id: "bridge-base-arbitrum", sourceAsset: BASE_USDC, destinationAsset: ARBITRUM_USDC,
  operation: "bridge", adapterId: "cctp-v2", executionMethod: "depositForBurn", finalityTracking: "partial"
});
const [plan] = findRoutePlans({ sourceAsset: AMBER, destinationAsset: ARBITRUM_USDC, amountInBaseUnits: 1_000_000n }, [swapLeg, bridgeLeg]);

function receipt(state: RouteExecutionReceipt["state"], quoteId: string, stage?: RouteFinalityStage, failure?: RouteExecutionReceipt["failureProof"]): RouteExecutionReceipt {
  return {
    executionId: `${quoteId}-execution`, quoteId, state, provider: "test",
    steps: [{ name: "submit", state }],
    ...(failure ? { failureProof: failure } : {}),
    ...(stage ? {
      finality: {
        schema: "localswap.finality.v1", executionId: `${quoteId}-execution`, quoteId, routeId: "bridge-base-arbitrum",
        routeFingerprint: routeDescriptorFingerprint(bridgeLeg), provider: "test", stage,
        cursor: { protocol: "cctp-v2", sourceDomain: 6, destinationDomain: 3, sourceTxCandidates: [] },
        evidence: [], revision: 1, createdAt: 1, updatedAt: 2
      }
    } : {})
  };
}

function outcome(legIndex: number, receiptValue: RouteExecutionReceipt): RoutePlanLegOutcome {
  return { legIndex, routeFingerprint: routeDescriptorFingerprint(plan.legs[legIndex]), quoteId: receiptValue.quoteId, receipt: receiptValue };
}

function storage(): ExecutionGuardStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key)
  };
}

describe("walking a plan, and what it means when the walk stops", () => {
  it("starts at the first leg and names what the holder is holding", () => {
    expect(routePlanAssetsInOrder(plan)).toEqual([AMBER, BASE_USDC, ARBITRUM_USDC]);
    const state = routePlanState(plan, []);
    expect(state).toEqual({ kind: "ready", legIndex: 0, route: plan.legs[0], heldAsset: AMBER });
  });

  it("will not start a leg against money that is still in flight", () => {
    const settledSwap = outcome(0, receipt("confirmed", "swap-quote"));
    // Submitted but not attested. The engine's own receipt says confirmed; the
    // bridge has not been observed arriving, so nothing may start against it.
    const inFlight = routePlanState(plan, [settledSwap, outcome(1, receipt("confirmed", "bridge-quote", "awaiting-proof"))]);
    expect(inFlight.kind).toBe("awaiting-settlement");
    expect(inFlight).toMatchObject({ legIndex: 1, stage: "awaiting-proof" });

    // A bridge with no finality record at all is the same answer, not a better one.
    const unobserved = routePlanState(plan, [settledSwap, outcome(1, receipt("confirmed", "bridge-quote"))]);
    expect(unobserved.kind).toBe("awaiting-settlement");

    const pending = routePlanState(plan, [settledSwap, outcome(1, receipt("pending", "bridge-quote", "source-included"))]);
    expect(pending).toMatchObject({ kind: "awaiting-settlement", legIndex: 1, stage: "source-included" });

    // Only arrival advances it.
    const arrived = routePlanState(plan, [settledSwap, outcome(1, receipt("confirmed", "bridge-quote", "destination-confirmed"))]);
    expect(arrived).toEqual({ kind: "complete", destinationAsset: ARBITRUM_USDC });
  });

  it("lets a swap settle on its own transaction, and moves to the next leg", () => {
    const state = routePlanState(plan, [outcome(0, receipt("confirmed", "swap-quote"))]);
    expect(state).toEqual({ kind: "ready", legIndex: 1, route: plan.legs[1], heldAsset: BASE_USDC });
  });

  it("separates nothing-moved from the holder now sitting on the intermediate asset", () => {
    const nothingMoved = routePlanState(plan, [outcome(0, receipt("failed", "swap-quote", undefined, { type: "no-value-transfer-submitted" }))]);
    expect(nothingMoved).toEqual({ kind: "stopped-before-any-value-moved", legIndex: 0, heldAsset: AMBER, code: "no-value-transfer-submitted" });

    const holding = routePlanState(plan, [
      outcome(0, receipt("confirmed", "swap-quote")),
      outcome(1, receipt("failed", "bridge-quote", undefined, { type: "no-value-transfer-submitted" }))
    ]);
    // This is the case that costs someone something, and it is named as such.
    expect(holding).toEqual({ kind: "holding-intermediate", legIndex: 1, heldAsset: BASE_USDC, code: "no-value-transfer-submitted" });
  });

  it("refuses to call an unreadable outcome either done or undone", () => {
    const state = routePlanState(plan, [outcome(0, receipt("confirmed", "swap-quote")), outcome(1, receipt("unknown", "bridge-quote"))]);
    expect(state).toEqual({ kind: "indeterminate", legIndex: 1, heldAsset: BASE_USDC });
  });

  it("stops when the route underneath the plan is not the route that was walked", () => {
    const stale = { ...outcome(0, receipt("confirmed", "swap-quote")), routeFingerprint: routeDescriptorFingerprint(descriptor({ ...swapLeg, trustBoundary: "changed" })) };
    expect(routePlanState(plan, [stale])).toEqual({ kind: "plan-superseded", legIndex: 0, heldAsset: AMBER });

    const swappedQuote = { ...outcome(0, receipt("confirmed", "swap-quote")), quoteId: "another-quote" };
    expect(routePlanState(plan, [swappedQuote])).toMatchObject({ kind: "plan-superseded" });
  });

  it("refuses a gap, an out-of-order leg, or more legs than the plan has", () => {
    const first = outcome(0, receipt("confirmed", "swap-quote"));
    const second = outcome(1, receipt("confirmed", "bridge-quote", "destination-confirmed"));
    expect(() => routePlanState(plan, [second])).toThrow("ROUTE_PLAN_PROGRESS_INVALID");
    expect(() => routePlanState(plan, [first, second, second])).toThrow("ROUTE_PLAN_PROGRESS_INVALID");
    expect(() => routePlanState(plan, [{ ...first, routeFingerprint: "0xnope" }])).toThrow("ROUTE_PLAN_PROGRESS_INVALID");
  });

  it("writes a stopped walk down and reads it back", () => {
    const store = storage();
    const outcomes = [outcome(0, receipt("confirmed", "swap-quote")), outcome(1, receipt("failed", "bridge-quote", undefined, { type: "no-value-transfer-submitted" }))];
    const record = createRoutePlanProgressRecord(plan, outcomes, 1_700_000_000_000);
    persistRoutePlanProgress(store, record);

    const read = readRoutePlanProgress(store, plan.planId);
    expect(read).toEqual(record);
    expect(read?.legs.map((leg) => leg.settled)).toEqual([true, false]);
    expect(read?.amountInBaseUnits).toBe("1000000");
    expect(routePlanProgressMatchesPlan(read!, plan)).toBe(true);
    // A plan whose legs changed is not the plan this walk belongs to.
    const [other] = findRoutePlans({ sourceAsset: AMBER, destinationAsset: ARBITRUM_USDC, amountInBaseUnits: 1_000_000n }, [{ ...swapLeg, trustBoundary: "changed" }, bridgeLeg]);
    expect(routePlanProgressMatchesPlan(read!, other)).toBe(false);
  });

  it("reads a written-down walk back into the same answer as the live one", () => {
    // The record keeps a summary and no receipts, so this is a second way in,
    // not the same code. It has to agree with the live reading or the record is
    // decoration.
    const cases: RoutePlanLegOutcome[][] = [
      [],
      [outcome(0, receipt("confirmed", "swap-quote"))],
      [outcome(0, receipt("confirmed", "swap-quote")), outcome(1, receipt("pending", "bridge-quote", "source-included"))],
      [outcome(0, receipt("confirmed", "swap-quote")), outcome(1, receipt("confirmed", "bridge-quote", "destination-confirmed"))],
      [outcome(0, receipt("confirmed", "swap-quote")), outcome(1, receipt("unknown", "bridge-quote"))]
    ];
    for (const outcomes of cases) {
      const record = createRoutePlanProgressRecord(plan, outcomes, 1_700_000_000_000);
      expect(routePlanStateFromRecord(plan, record).kind, JSON.stringify(outcomes.map((leg) => leg.receipt.state)))
        .toBe(routePlanState(plan, outcomes).kind);
    }
  });

  it("names the held asset when a written-down walk stopped halfway", () => {
    const outcomes = [
      outcome(0, receipt("confirmed", "swap-quote")),
      outcome(1, receipt("failed", "bridge-quote", undefined, { type: "no-value-transfer-submitted" }))
    ];
    const record = createRoutePlanProgressRecord(plan, outcomes, 1_700_000_000_000);
    // The costly case survives being written down: still a position, not a failure.
    expect(routePlanStateFromRecord(plan, record)).toEqual({ kind: "holding-intermediate", legIndex: 1, heldAsset: BASE_USDC, code: "recorded-failure" });

    const first = [outcome(0, receipt("failed", "swap-quote", undefined, { type: "no-value-transfer-submitted" }))];
    expect(routePlanStateFromRecord(plan, createRoutePlanProgressRecord(plan, first, 1_700_000_000_000)))
      .toEqual({ kind: "stopped-before-any-value-moved", legIndex: 0, heldAsset: AMBER, code: "recorded-failure" });
  });

  it("refuses to read one plan's walk as another plan's", () => {
    // The v0.1 screen once showed a saved record belonging to a different pair
    // under a heading that called it route-bound. Not again.
    const record = createRoutePlanProgressRecord(plan, [outcome(0, receipt("confirmed", "swap-quote"))], 1_700_000_000_000);
    const [other] = findRoutePlans(
      { sourceAsset: AMBER, destinationAsset: ARBITRUM_USDC, amountInBaseUnits: 1_000_000n },
      [{ ...swapLeg, trustBoundary: "a different route" }, bridgeLeg]
    );
    expect(routePlanStateFromRecord(other, record)).toEqual({ kind: "plan-superseded", legIndex: 0, heldAsset: AMBER });
  });

  it("treats an altered or unreadable record as no walk at all", () => {
    const store = storage();
    const record = createRoutePlanProgressRecord(plan, [outcome(0, receipt("confirmed", "swap-quote"))], 1_700_000_000_000);
    persistRoutePlanProgress(store, record);
    const key = routePlanProgressKey(plan.planId);

    store.map.set(key, "{not json");
    expect(readRoutePlanProgress(store, plan.planId)).toBeNull();
    store.map.set(key, JSON.stringify({ ...record, planId: routeDescriptorFingerprint(bridgeLeg) }));
    expect(readRoutePlanProgress(store, plan.planId)).toBeNull();
    // The dangerous edit: a leg marked settled that never confirmed would let a
    // resume walk straight past live money.
    store.map.set(key, JSON.stringify({ ...record, legs: [{ ...record.legs[0], receiptState: "pending" }] }));
    expect(readRoutePlanProgress(store, plan.planId)).toBeNull();
    expect(() => assertRoutePlanProgressRecord({ ...record, legs: [{ ...record.legs[0], receiptState: "pending" }] })).toThrow("ROUTE_PLAN_PROGRESS_RECORD_INVALID");
  });
});
