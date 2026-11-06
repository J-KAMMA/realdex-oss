import { isCaip19 } from "../universe/registry";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { assertBoundQuote, assertRouteDescriptor, routeDescriptorFingerprint } from "./engine";
import type { RouteDescriptor, RouteQuote, RouteQuoteRequest, UniversalQuoteAdapter } from "./types";

// A swap and a bridge joined end to end, without pretending they are one
// transaction. They cannot be: the second leg has nothing to spend until the
// first leg's funds have arrived on the other chain, which is minutes away and
// needs a second signature from a wallet on that chain.
//
// So this is a *plan*, never an authorization. It names which routes join, at
// which asset, and what the compounded floor would be. Each leg is still quoted
// and executed one at a time through the engine, which keeps its single-leg
// guarantees intact — one execution guard, one finality cursor, one signed
// intent per leg. Between the legs the holder is holding the intermediate asset
// and may simply stop there; the plan says so out loud rather than hiding it.
// Three legs is the shape this exists for: swap into the bridged asset on one
// chain, cross, swap out on the other. Two would only ever reach half of it.
const MAXIMUM_LEGS = 3;
const MAXIMUM_PLANS = 32;

export type RoutePlanIntent = {
  sourceAsset: string;
  destinationAsset: string;
  amountInBaseUnits: bigint;
};

export type RoutePlan = {
  schema: "realdex.route-plan.v1";
  planId: string;
  sourceAsset: string;
  destinationAsset: string;
  amountInBaseUnits: bigint;
  legs: RouteDescriptor[];
  /** The assets held between the legs. Empty for a direct route. */
  intermediateAssets: string[];
  /** Every chain the holder needs a wallet on, in the order they are used. */
  chainIds: string[];
};

export type QuotedRoutePlanLeg = {
  index: number;
  route: RouteDescriptor;
  /** Null when the caller could not yet form a request for this leg — typically
   *  because the wallet for its chain is not connected. The plan is still real;
   *  only its estimate is missing. */
  quote: RouteQuote | null;
  amountInBaseUnits: bigint;
  rejectionCode?: string;
};

export type QuotedRoutePlan = {
  plan: RoutePlan;
  legs: QuotedRoutePlanLeg[];
  /** Always true. A plan is an estimate; only a leg's own quote authorizes it. */
  estimate: true;
  /** Compounded from each leg's *minimum*, so it is a floor and not a hope.
   *  Null when any leg could not be quoted. */
  minimumOutBaseUnits: bigint | null;
  expectedOutBaseUnits: bigint | null;
  estimatedSeconds: number | null;
  unpricedCosts: string[];
};

/** Builds the request for one leg. Returning null means "not yet" — the leg is
 *  reported unquoted rather than the whole plan being dropped. */
export type RoutePlanLegRequestFactory = (leg: {
  index: number;
  route: RouteDescriptor;
  amountInBaseUnits: bigint;
}) => RouteQuoteRequest | null;

function assertRoutePlanIntent(intent: RoutePlanIntent): void {
  if (!isCaip19(intent.sourceAsset) || !isCaip19(intent.destinationAsset)) throw new Error("ROUTE_PLAN_ASSET_INVALID");
  if (intent.sourceAsset === intent.destinationAsset) throw new Error("ROUTE_PLAN_ASSETS_IDENTICAL");
  if (intent.amountInBaseUnits <= 0n) throw new Error("ROUTE_PLAN_AMOUNT_INVALID");
}

function routePlanFingerprint(plan: Omit<RoutePlan, "planId" | "schema">): string {
  return cryptographicFingerprint("realdex.route-plan.v1", {
    sourceAsset: plan.sourceAsset,
    destinationAsset: plan.destinationAsset,
    amountInBaseUnits: plan.amountInBaseUnits,
    legs: plan.legs.map((leg) => routeDescriptorFingerprint(leg))
  });
}

function usableRoutes(routes: readonly RouteDescriptor[]): RouteDescriptor[] {
  return routes.filter((route) => {
    try {
      assertRouteDescriptor(route);
      return true;
    } catch {
      return false;
    }
  });
}

/** Finds the leg sequences that carry the intent, reading nothing off-chain. */
export function findRoutePlans(intent: RoutePlanIntent, routes: readonly RouteDescriptor[]): RoutePlan[] {
  assertRoutePlanIntent(intent);
  const usable = usableRoutes(routes);

  const found: RoutePlan[] = [];
  const seen = new Set<string>();
  const admit = (legs: RouteDescriptor[]) => {
    if (found.length >= MAXIMUM_PLANS) return;
    const plan = buildPlan(intent, legs);
    if (!plan || seen.has(plan.planId)) return;
    seen.add(plan.planId);
    found.push(plan);
  };

  // Depth-first over legs that join end to end, bounded by both the leg ceiling
  // and the plan ceiling so a large registry cannot turn a search into a hang.
  const walk = (legs: RouteDescriptor[]) => {
    if (found.length >= MAXIMUM_PLANS) return;
    const held = legs.length ? legs[legs.length - 1].destinationAsset : intent.sourceAsset;
    if (held === intent.destinationAsset) {
      admit(legs);
      return;
    }
    if (legs.length >= MAXIMUM_LEGS) return;
    for (const next of usable) {
      if (next.sourceAsset !== held) continue;
      if (legs.some((leg) => leg.id === next.id)) continue;
      walk([...legs, next]);
    }
  };
  walk([]);

  found.sort((left, right) => left.legs.length - right.legs.length || left.planId.localeCompare(right.planId));
  return found;
}

export type RoutePlanGap = {
  /** A route from here to there would complete a plan. */
  sourceAsset: string;
  destinationAsset: string;
  /** How many legs the finished plan would have, this one included. */
  legs: number;
};

/**
 * When nothing joins, this says what single route would. "No plan" is a dead
 * end; "a pool from AMBR to Base Sepolia USDC would join these" is a direction,
 * and it is the same search run from both ends until they nearly meet.
 */
export function findRoutePlanGaps(intent: RoutePlanIntent, routes: readonly RouteDescriptor[]): RoutePlanGap[] {
  assertRoutePlanIntent(intent);
  if (findRoutePlans(intent, routes).length) return [];
  const usable = usableRoutes(routes);

  // How few legs it takes to get from the source to each asset, and from each
  // asset to the destination. Anything beyond the ceiling is out of reach.
  const forward = reachable(intent.sourceAsset, usable, (route) => [route.sourceAsset, route.destinationAsset]);
  const backward = reachable(intent.destinationAsset, usable, (route) => [route.destinationAsset, route.sourceAsset]);
  const gaps: RoutePlanGap[] = [];
  for (const [from, before] of forward) {
    for (const [to, after] of backward) {
      if (from === to) continue;
      const legs = before + 1 + after;
      if (legs > MAXIMUM_LEGS) continue;
      // No check for a route that already exists is needed here: within the leg
      // ceiling, if one did exist between a reachable pair, that walk would be a
      // plan and this search would never have run. Verified by breaking it.
      gaps.push({ sourceAsset: from, destinationAsset: to, legs });
    }
  }
  // Fewest legs first: the smallest thing someone could build.
  gaps.sort((left, right) => left.legs - right.legs || left.sourceAsset.localeCompare(right.sourceAsset) || left.destinationAsset.localeCompare(right.destinationAsset));
  return gaps.slice(0, MAXIMUM_PLANS);
}

/** Assets within the leg ceiling of `origin`, and how many legs each one costs. */
function reachable(origin: string, routes: readonly RouteDescriptor[], ends: (route: RouteDescriptor) => [string, string]): Map<string, number> {
  const distance = new Map<string, number>([[origin, 0]]);
  let frontier = [origin];
  for (let depth = 1; depth < MAXIMUM_LEGS && frontier.length; depth++) {
    const next: string[] = [];
    for (const route of routes) {
      const [from, to] = ends(route);
      if (!frontier.includes(from) || distance.has(to)) continue;
      distance.set(to, depth);
      next.push(to);
    }
    frontier = next;
  }
  return distance;
}

function buildPlan(intent: RoutePlanIntent, legs: RouteDescriptor[]): RoutePlan | null {
  if (!legs.length || legs.length > MAXIMUM_LEGS) return null;
  if (legs[0].sourceAsset !== intent.sourceAsset) return null;
  if (legs[legs.length - 1].destinationAsset !== intent.destinationAsset) return null;
  if (new Set(legs.map((leg) => leg.id)).size !== legs.length) return null;

  const assets = [legs[0].sourceAsset];
  for (const leg of legs) {
    if (leg.sourceAsset !== assets[assets.length - 1]) return null;
    assets.push(leg.destinationAsset);
  }
  // A plan that returns to an asset it already held is a loop, not a route.
  if (new Set(assets).size !== assets.length) return null;

  const shape = {
    sourceAsset: intent.sourceAsset,
    destinationAsset: intent.destinationAsset,
    amountInBaseUnits: intent.amountInBaseUnits,
    legs,
    intermediateAssets: assets.slice(1, -1),
    chainIds: dedupeInOrder(assets.map(chainIdOf))
  };
  return { schema: "realdex.route-plan.v1", planId: routePlanFingerprint(shape), ...shape };
}

/** Quotes each leg in order, feeding the previous leg's *minimum* forward. */
export async function quoteRoutePlan(
  plan: RoutePlan,
  legRequest: RoutePlanLegRequestFactory,
  adapters: readonly UniversalQuoteAdapter[],
  now: number = Date.now()
): Promise<QuotedRoutePlan> {
  const adapterById = new Map(adapters.map((adapter) => [adapter.adapterId, adapter]));
  const legs: QuotedRoutePlanLeg[] = [];
  let carried: bigint | null = plan.amountInBaseUnits;
  let expected: bigint | null = plan.amountInBaseUnits;
  let seconds = 0;
  let secondsKnown = true;
  const unpricedCosts: string[] = [];

  for (let index = 0; index < plan.legs.length; index++) {
    const route = plan.legs[index];
    if (carried === null || carried <= 0n) {
      legs.push({ index, route, quote: null, amountInBaseUnits: 0n, rejectionCode: "ROUTE_PLAN_LEG_INPUT_UNKNOWN" });
      continue;
    }
    const amountInBaseUnits = carried;
    const request = legRequest({ index, route, amountInBaseUnits });
    if (!request) {
      legs.push({ index, route, quote: null, amountInBaseUnits, rejectionCode: "ROUTE_PLAN_LEG_REQUEST_UNAVAILABLE" });
      carried = null;
      expected = null;
      continue;
    }
    if (request.sourceAsset !== route.sourceAsset || request.destinationAsset !== route.destinationAsset || request.amountInBaseUnits !== amountInBaseUnits) {
      legs.push({ index, route, quote: null, amountInBaseUnits, rejectionCode: "ROUTE_PLAN_LEG_REQUEST_MISMATCH" });
      carried = null;
      expected = null;
      continue;
    }
    const adapter = adapterById.get(route.adapterId);
    if (!adapter || !adapter.supports(route)) {
      legs.push({ index, route, quote: null, amountInBaseUnits, rejectionCode: "ADAPTER_NOT_INSTALLED" });
      carried = null;
      expected = null;
      continue;
    }
    try {
      const quote = await adapter.quote(route, request);
      assertBoundQuote(route, request, quote, now);
      legs.push({ index, route, quote, amountInBaseUnits });
      // The floor compounds off the floor. Feeding the expected amount forward
      // would quietly turn two estimates into one confident number.
      carried = quote.minimumOutBaseUnits;
      expected = expected === null ? null : quote.expectedOutBaseUnits;
      if (quote.estimatedSeconds === null) secondsKnown = false;
      else seconds += quote.estimatedSeconds;
      for (const cost of quote.unpricedCosts) unpricedCosts.push(cost);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "QUOTE_PROVIDER_FAILED";
      legs.push({ index, route, quote: null, amountInBaseUnits, rejectionCode: /^[A-Z][A-Z0-9_]+$/.test(code) ? code : "QUOTE_PROVIDER_FAILED" });
      carried = null;
      expected = null;
    }
  }

  const complete = legs.length === plan.legs.length && legs.every((leg) => leg.quote !== null);
  if (plan.legs.length > 1) {
    unpricedCosts.push(`every leg after the first is quoted again once the leg before it settles, so its price is not fixed here`);
    unpricedCosts.push(`between the legs the holder holds ${plan.intermediateAssets.join(", ")} and may stop there`);
    unpricedCosts.push(`a wallet is needed on each of ${plan.chainIds.join(", ")}`);
  }

  return {
    plan,
    legs,
    estimate: true,
    minimumOutBaseUnits: complete ? carried : null,
    expectedOutBaseUnits: complete ? expected : null,
    estimatedSeconds: complete && secondsKnown ? seconds : null,
    unpricedCosts: dedupeInOrder(unpricedCosts)
  };
}

/** Which leg to run next, given how many have already settled. */
export function nextRoutePlanLeg(plan: RoutePlan, settledLegCount: number): RouteDescriptor | null {
  if (!Number.isInteger(settledLegCount) || settledLegCount < 0 || settledLegCount > plan.legs.length) throw new Error("ROUTE_PLAN_PROGRESS_INVALID");
  return settledLegCount === plan.legs.length ? null : plan.legs[settledLegCount];
}

function dedupeInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function chainIdOf(assetType: string): string {
  return assetType.slice(0, assetType.indexOf("/"));
}
