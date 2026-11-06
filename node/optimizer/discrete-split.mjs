import { amount, assertContext, identifier, record, requireCondition, safeInteger, UINT256_MAX } from './quote-objective.mjs';

/** Matches the existing LocalSwapPool exact-input formula, including integer
 * truncation. No guarantee about reserves being genuine/current is implied. */
export function constantProductOut(amountIn, reserveIn, reserveOut, feeBasisPoints) {
  amount(amountIn, true); amount(reserveIn, true); amount(reserveOut, true);
  safeInteger(feeBasisPoints, 1, 100, 'FEE_TIER_INVALID');
  const maxReserve = (1n << 112n) - 1n;
  requireCondition(reserveIn <= maxReserve && reserveOut <= maxReserve, 'RESERVE_OVERFLOW');
  const adjusted = amountIn * BigInt(10000 - feeBasisPoints);
  const denominator = reserveIn * 10000n + adjusted;
  requireCondition(adjusted <= UINT256_MAX && adjusted * reserveOut <= UINT256_MAX && denominator <= UINT256_MAX, 'QUOTE_ARITHMETIC_OVERFLOW');
  return adjusted * reserveOut / denominator;
}

/** Exact dynamic programming over a supplied, finite quote grid. All routes must
 * be same-chain, share one snapshot, and have disjoint pool resources. No bridge,
 * overlapping pools, fee oracle, transaction construction, or signing is installed.
 * A split plan is a proposal only: the current on-chain router cannot execute it. */
export function optimizeDiscreteSplit(context, routes, options) {
  assertContext(context);
  record(options, ['now', 'quantum', 'maximumSplits', 'snapshotId', 'fixedExecutionCostOut'], 'SPLIT_OPTIONS_INVALID');
  safeInteger(options.now, 1, Number.MAX_SAFE_INTEGER, 'CLOCK_INVALID');
  amount(options.quantum, true); amount(options.fixedExecutionCostOut);
  safeInteger(options.maximumSplits, 1, 4, 'SPLIT_COUNT_INVALID');
  requireCondition(identifier(options.snapshotId), 'SNAPSHOT_ID_INVALID');
  requireCondition(context.amountIn % options.quantum === 0n, 'AMOUNT_NOT_ON_GRID');
  const stepsBig = context.amountIn / options.quantum;
  requireCondition(stepsBig >= 1n && stepsBig <= 128n, 'GRID_LIMIT'); const steps = Number(stepsBig);
  const chainId = context.sourceAsset.split('/')[0];
  requireCondition(chainId === context.destinationAsset.split('/')[0], 'CROSS_CHAIN_SPLIT_NOT_SUPPORTED');
  requireCondition(Array.isArray(routes) && routes.length >= 1 && routes.length <= 8, 'SPLIT_ROUTE_LIMIT');
  const routeIds = new Set(); const resources = new Set();
  for (const route of routes) {
    record(route, ['routeId', 'requestId', 'sourceAsset', 'destinationAsset', 'snapshotId', 'poolIds', 'samples'], 'SPLIT_ROUTE_INVALID');
    requireCondition(identifier(route.routeId) && !routeIds.has(route.routeId), 'SPLIT_ROUTE_DUPLICATE'); routeIds.add(route.routeId);
    requireCondition(route.requestId === context.requestId && route.sourceAsset === context.sourceAsset && route.destinationAsset === context.destinationAsset && route.snapshotId === options.snapshotId, 'SPLIT_CONTEXT_MISMATCH');
    requireCondition(Array.isArray(route.poolIds) && route.poolIds.length >= 1 && route.poolIds.length <= 4 && route.poolIds.every(identifier), 'POOL_RESOURCES_REQUIRED');
    for (const id of route.poolIds) { requireCondition(!resources.has(id), 'OVERLAPPING_POOLS_NOT_SUPPORTED'); resources.add(id); }
    requireCondition(Array.isArray(route.samples) && route.samples.length === steps, 'QUOTE_GRID_INCOMPLETE');
    route.samples.forEach((sample, i) => {
      if (sample === null) return; // An explicitly unavailable grid cell is not a free route.
      record(sample, ['steps', 'minimumOut', 'additionalCostOut', 'expiresAt'], 'SAMPLE_INVALID');
      requireCondition(sample.steps === i + 1, 'GRID_STEP_MISMATCH'); amount(sample.minimumOut, true); amount(sample.additionalCostOut);
      safeInteger(sample.expiresAt, options.now + 1, Number.MAX_SAFE_INTEGER, 'SAMPLE_EXPIRED');
    });
  }
  const ordered = [...routes].sort((a, b) => a.routeId < b.routeId ? -1 : 1);
  let dp = Array.from({ length: steps + 1 }, () => Array(options.maximumSplits + 1).fill(null));
  dp[0][0] = { score: 0n, minimumOut: 0n, additionalCostOut: 0n, validUntil: Number.MAX_SAFE_INTEGER, allocations: [] };
  let transitions = 0;
  for (const route of ordered) {
    const next = dp.map(row => row.slice());
    for (let used = 0; used < steps; used++) for (let splits = 0; splits < options.maximumSplits; splits++) {
      const base = dp[used][splits]; if (!base) continue;
      for (let take = 1; used + take <= steps; take++) {
        const sample = route.samples[take - 1]; if (!sample) continue; transitions++;
        const candidate = { score: base.score + sample.minimumOut - sample.additionalCostOut,
          minimumOut: base.minimumOut + sample.minimumOut, additionalCostOut: base.additionalCostOut + sample.additionalCostOut,
          validUntil: Math.min(base.validUntil, sample.expiresAt),
          allocations: [...base.allocations, { routeId: route.routeId, amountIn: BigInt(take) * options.quantum,
            steps: take, minimumOut: sample.minimumOut, additionalCostOut: sample.additionalCostOut }] };
        const existing = next[used + take][splits + 1];
        if (!existing || candidate.score > existing.score) next[used + take][splits + 1] = candidate;
      }
    }
    dp = next;
  }
  let best = null;
  for (let splits = 1; splits <= options.maximumSplits; splits++) {
    const candidate = dp[steps][splits];
    // Iterate fewest splits first: equal net output uses fewer routes.
    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  }
  if (!best || best.score <= options.fixedExecutionCostOut) return { state: 'no-positive-net-plan', executable: false,
    optimality: 'exact-within-supplied-disjoint-quote-grid', globalOptimality: false, transitions, plan: null };
  const plan = { ...best, score: best.score - options.fixedExecutionCostOut,
    additionalCostOut: best.additionalCostOut + options.fixedExecutionCostOut, requestId: context.requestId,
    snapshotId: options.snapshotId, amountIn: context.amountIn, quantum: options.quantum };
  return { state: 'proposal-only', executable: false, optimality: 'exact-within-supplied-disjoint-quote-grid',
    globalOptimality: false, transitions, plan };
}
