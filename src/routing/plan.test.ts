import { describe, expect, it } from "vitest";
import { routeDescriptorFingerprint, routeRequestFingerprint } from "./engine";
import { findRoutePlanGaps, findRoutePlans, nextRoutePlanLeg, quoteRoutePlan, type RoutePlanIntent } from "./plan";
import type { RouteDescriptor, RouteQuote, RouteQuoteRequest, UniversalQuoteAdapter } from "./types";
import { createProviderBindingGrant } from "../wallet/capabilities";

const AMBER = "eip155:84532/erc20:0xa7aD1A578C2758D761F8DB4D1C8220b3fCcf4996";
const BASE_USDC = "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ARBITRUM_USDC = "eip155:421614/erc20:0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const ARBITRUM_JADE = "eip155:421614/erc20:0x973aDa85eA6Eb4C9C2406e80a7E86c6b8F6cc31a";
const ACCOUNT = "eip155:84532:0x1111111111111111111111111111111111111111";

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
const swapOutLeg = descriptor({ id: "swap-usdc-jade", sourceAsset: ARBITRUM_USDC, destinationAsset: ARBITRUM_JADE });
const directLeg = descriptor({ id: "direct-amber-arbitrum", sourceAsset: AMBER, destinationAsset: ARBITRUM_USDC });
const intent: RoutePlanIntent = { sourceAsset: AMBER, destinationAsset: ARBITRUM_USDC, amountInBaseUnits: 1_000_000n };

function requestFor(route: RouteDescriptor, amountInBaseUnits: bigint, now = Date.now()): RouteQuoteRequest {
  return {
    executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000001",
    sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset, amountInBaseUnits,
    accountId: ACCOUNT, recipient: "0x2222222222222222222222222222222222222222",
    walletCapabilityId: "eip1193", sessionRevision: 2,
    walletGrant: createProviderBindingGrant({ transportId: "test:alpha", accountId: ACCOUNT, walletCapabilityId: "eip1193", sessionRevision: 2, expiresAt: now + 120_000 }),
    slippageBps: 50
  };
}

function quoteFor(route: RouteDescriptor, request: RouteQuoteRequest, expected: bigint, minimum: bigint, now: number): RouteQuote {
  return {
    quoteId: `${route.id}-quote`, routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route),
    requestFingerprint: routeRequestFingerprint(request), adapterId: route.adapterId,
    amountInBaseUnits: request.amountInBaseUnits, expectedOutBaseUnits: expected, minimumOutBaseUnits: minimum,
    fees: [], unpricedCosts: [`${route.id} network fee is paid in the chain's own gas token`],
    expiresAt: now + 60_000, estimatedSeconds: 30,
    authorization: { type: "approval", spender: "0x3333333333333333333333333333333333333333", amountBaseUnits: request.amountInBaseUnits, expiresAt: now + 60_000 },
    executionPreview: { chainId: route.sourceAsset.slice(0, route.sourceAsset.indexOf("/")), target: route.sourceExecutionTarget, method: route.executionMethod, valueBaseUnits: 0n },
    adapterData: { format: "mock.v1", value: {} }
  };
}

/** Halves on the expected side, tenths on the floor — so the two are never confusable. */
function adapter(id: string, now: number): UniversalQuoteAdapter {
  return {
    adapterId: id,
    supports: (route) => route.adapterId === id,
    quote: async (route, request) => quoteFor(route, request, request.amountInBaseUnits / 2n, request.amountInBaseUnits / 10n, now)
  };
}

describe("route plans that join a swap and a bridge without pretending they are one transaction", () => {
  it("finds the two-leg sequence and names what it costs the holder to walk it", () => {
    const plans = findRoutePlans(intent, [swapLeg, bridgeLeg]);
    expect(plans).toHaveLength(1);
    expect(plans[0].legs.map((leg) => leg.id)).toEqual(["swap-amber-usdc", "bridge-base-arbitrum"]);
    // The asset held in between, and every chain a wallet is needed on.
    expect(plans[0].intermediateAssets).toEqual([BASE_USDC]);
    expect(plans[0].chainIds).toEqual(["eip155:84532", "eip155:421614"]);
    expect(plans[0].planId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("prefers a direct route and still offers the long way round", () => {
    const plans = findRoutePlans(intent, [swapLeg, bridgeLeg, directLeg]);
    expect(plans.map((plan) => plan.legs.length)).toEqual([1, 2]);
    expect(plans[0].legs[0].id).toBe("direct-amber-arbitrum");
    expect(plans[0].intermediateAssets).toEqual([]);
    expect(plans[0].chainIds).toEqual(["eip155:84532", "eip155:421614"]);
  });

  it("carries the whole shape this exists for: swap in, cross, swap out", () => {
    const plans = findRoutePlans({ ...intent, destinationAsset: ARBITRUM_JADE }, [swapLeg, bridgeLeg, swapOutLeg]);
    expect(plans).toHaveLength(1);
    expect(plans[0].legs.map((leg) => leg.id)).toEqual(["swap-amber-usdc", "bridge-base-arbitrum", "swap-usdc-jade"]);
    expect(plans[0].intermediateAssets).toEqual([BASE_USDC, ARBITRUM_USDC]);
    expect(plans[0].chainIds).toEqual(["eip155:84532", "eip155:421614"]);
    // Four legs is past the ceiling, so a longer way round is simply not offered.
    const detour = descriptor({ id: "swap-jade-amber-arb", sourceAsset: ARBITRUM_JADE, destinationAsset: "eip155:421614/erc20:0x9999999999999999999999999999999999999999" });
    expect(findRoutePlans({ ...intent, destinationAsset: detour.destinationAsset }, [swapLeg, bridgeLeg, swapOutLeg, detour])).toEqual([]);
  });

  it("refuses legs that do not join, loops, and descriptors that are not executable", () => {
    // The bridge alone does not start where the holder is.
    expect(findRoutePlans(intent, [bridgeLeg])).toEqual([]);
    // A route that leaves an asset and comes back to it is a loop, not a route:
    // the only plan here is the direct one, never AMBER → USDC → AMBER → target.
    const backToAmber = descriptor({ id: "swap-usdc-amber", sourceAsset: BASE_USDC, destinationAsset: AMBER });
    const loopy = findRoutePlans(intent, [swapLeg, backToAmber, directLeg]);
    expect(loopy).toHaveLength(1);
    expect(loopy[0].legs.map((leg) => leg.id)).toEqual(["direct-amber-arbitrum"]);
    // A descriptor the engine would refuse never reaches a plan.
    expect(findRoutePlans(intent, [{ ...swapLeg, state: "design-gate" }, bridgeLeg])).toEqual([]);
    expect(findRoutePlans(intent, [swapLeg, { ...bridgeLeg, evidenceUrls: [] }])).toEqual([]);
    expect(() => findRoutePlans({ ...intent, amountInBaseUnits: 0n }, [swapLeg])).toThrow("ROUTE_PLAN_AMOUNT_INVALID");
    expect(() => findRoutePlans({ ...intent, destinationAsset: AMBER }, [swapLeg])).toThrow("ROUTE_PLAN_ASSETS_IDENTICAL");
  });

  it("compounds the floor off the floor, not off the hoped-for amount", async () => {
    const now = Date.now();
    const [plan] = findRoutePlans(intent, [swapLeg, bridgeLeg]);
    const quoted = await quoteRoutePlan(plan, ({ route, amountInBaseUnits }) => requestFor(route, amountInBaseUnits, now), [adapter("mock", now), adapter("cctp-v2", now)], now);

    expect(quoted.estimate).toBe(true);
    // Leg two is quoted on leg one's minimum (100_000), not its expected (500_000).
    expect(quoted.legs[1].amountInBaseUnits).toBe(100_000n);
    expect(quoted.minimumOutBaseUnits).toBe(10_000n);
    // Had the floor compounded off the expected amount it would read 50_000.
    expect(quoted.minimumOutBaseUnits).not.toBe(50_000n);
    expect(quoted.expectedOutBaseUnits).toBe(50_000n);
    expect(quoted.estimatedSeconds).toBe(60);
  });

  it("says out loud what it is not pricing", async () => {
    const now = Date.now();
    const [plan] = findRoutePlans(intent, [swapLeg, bridgeLeg]);
    const quoted = await quoteRoutePlan(plan, ({ route, amountInBaseUnits }) => requestFor(route, amountInBaseUnits, now), [adapter("mock", now), adapter("cctp-v2", now)], now);

    const costs = quoted.unpricedCosts.join(" | ");
    expect(costs).toContain("quoted again once the leg before it settles");
    expect(costs).toContain("may stop there");
    expect(costs).toContain("eip155:421614");
    // Each leg's own unpriced costs survive, and nothing is listed twice.
    expect(quoted.unpricedCosts).toEqual([...new Set(quoted.unpricedCosts)]);
    expect(costs).toContain("swap-amber-usdc network fee");
  });

  it("keeps the plan when a leg cannot be quoted yet, and withholds the estimate", async () => {
    const now = Date.now();
    const [plan] = findRoutePlans(intent, [swapLeg, bridgeLeg]);
    // The wallet for the second leg is not connected.
    const quoted = await quoteRoutePlan(plan, ({ index, route, amountInBaseUnits }) => (index === 0 ? requestFor(route, amountInBaseUnits, now) : null), [adapter("mock", now), adapter("cctp-v2", now)], now);

    expect(quoted.legs[0].quote).not.toBeNull();
    expect(quoted.legs[1].quote).toBeNull();
    expect(quoted.legs[1].rejectionCode).toBe("ROUTE_PLAN_LEG_REQUEST_UNAVAILABLE");
    // No number is offered rather than a number that is missing a leg.
    expect(quoted.minimumOutBaseUnits).toBeNull();
    expect(quoted.expectedOutBaseUnits).toBeNull();
    expect(quoted.estimatedSeconds).toBeNull();
  });

  it("refuses a leg request that does not match the leg it is for", async () => {
    const now = Date.now();
    const [plan] = findRoutePlans(intent, [swapLeg, bridgeLeg]);
    const missing = await quoteRoutePlan(plan, ({ route, amountInBaseUnits }) => requestFor(route, amountInBaseUnits + 1n, now), [adapter("mock", now)], now);
    expect(missing.legs[0].rejectionCode).toBe("ROUTE_PLAN_LEG_REQUEST_MISMATCH");

    const uninstalled = await quoteRoutePlan(plan, ({ route, amountInBaseUnits }) => requestFor(route, amountInBaseUnits, now), [adapter("mock", now)], now);
    expect(uninstalled.legs[1].rejectionCode).toBe("ADAPTER_NOT_INSTALLED");
    expect(uninstalled.minimumOutBaseUnits).toBeNull();
  });

  it("says nothing about gaps while a plan exists", () => {
    expect(findRoutePlanGaps(intent, [swapLeg, bridgeLeg])).toEqual([]);
  });

  it("turns a dead end into the one route that would open it", () => {
    // A swap that goes nowhere useful, and a bridge that starts somewhere the
    // holder cannot reach. Nothing joins — the shape of the real deployment.
    const sideways = descriptor({ id: "swap-amber-jade", sourceAsset: AMBER, destinationAsset: ARBITRUM_JADE });
    const gaps = findRoutePlanGaps(intent, [sideways, bridgeLeg]);
    expect(gaps.length).toBeGreaterThan(0);
    // Fewest legs first: the smallest thing anyone could build.
    expect(gaps[0]).toEqual({ sourceAsset: AMBER, destinationAsset: ARBITRUM_USDC, legs: 1 });
    // And the two-leg answers, which are the ones worth deploying.
    expect(gaps).toContainEqual({ sourceAsset: AMBER, destinationAsset: BASE_USDC, legs: 2 });
    expect(gaps).toContainEqual({ sourceAsset: ARBITRUM_JADE, destinationAsset: ARBITRUM_USDC, legs: 2 });
    expect(gaps.every((gap) => gap.legs <= 3)).toBe(true);
    // Never suggest a route from an asset to itself.
    expect(gaps.every((gap) => gap.sourceAsset !== gap.destinationAsset)).toBe(true);
  });

  it("will not suggest a route that leaves the plan longer than the ceiling", () => {
    // Two legs out from the source, two legs back from the destination, and a
    // hole in the middle. Bridging that hole would take five legs, which is not
    // a plan this can carry — it must not be offered as though it were.
    const far = (suffix: string) => `eip155:421614/erc20:0x${suffix.repeat(40)}`;
    const X = far("7"), Y = far("8"), Z = far("9");
    const chain = [
      descriptor({ id: "out-1", sourceAsset: AMBER, destinationAsset: BASE_USDC }),
      descriptor({ id: "out-2", sourceAsset: BASE_USDC, destinationAsset: ARBITRUM_JADE }),
      descriptor({ id: "in-2", sourceAsset: X, destinationAsset: Y }),
      descriptor({ id: "in-1", sourceAsset: Y, destinationAsset: Z })
    ];
    const gaps = findRoutePlanGaps({ ...intent, destinationAsset: Z }, chain);
    // The one-leg answer, and a middle answer that does fit.
    expect(gaps[0]).toEqual({ sourceAsset: AMBER, destinationAsset: Z, legs: 1 });
    expect(gaps).toContainEqual({ sourceAsset: BASE_USDC, destinationAsset: Y, legs: 3 });
    // The far pair would need five legs. It is the one that must not appear.
    expect(gaps).not.toContainEqual(expect.objectContaining({ sourceAsset: ARBITRUM_JADE, destinationAsset: X }));
    expect(gaps.every((gap) => gap.legs <= 3)).toBe(true);
  });

  it("walks the legs one at a time and refuses nonsense progress", () => {
    const [plan] = findRoutePlans(intent, [swapLeg, bridgeLeg]);
    expect(nextRoutePlanLeg(plan, 0)?.id).toBe("swap-amber-usdc");
    expect(nextRoutePlanLeg(plan, 1)?.id).toBe("bridge-base-arbitrum");
    expect(nextRoutePlanLeg(plan, 2)).toBeNull();
    expect(() => nextRoutePlanLeg(plan, 3)).toThrow("ROUTE_PLAN_PROGRESS_INVALID");
    expect(() => nextRoutePlanLeg(plan, -1)).toThrow("ROUTE_PLAN_PROGRESS_INVALID");
  });
});
