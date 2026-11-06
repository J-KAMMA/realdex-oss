/**
 * Pure exact-input comparison. This module neither authenticates a quote nor
 * signs/submits a transaction. The caller MUST first use the existing local
 * adapter's request/account/recipient/session binding and simulation checks.
 * Amounts are integers in each asset's smallest unit, never Number/float money.
 */
export const UINT256_MAX = (1n << 256n) - 1n;
export function requireCondition(ok, code) { if (!ok) throw new Error(code); }
export function amount(value, positive = false) {
  requireCondition(typeof value === 'bigint' && value >= (positive ? 1n : 0n) && value <= UINT256_MAX, 'AMOUNT_INVALID'); return value;
}
export function safeInteger(value, min, max, code) { requireCondition(Number.isSafeInteger(value) && value >= min && value <= max, code); }
export function record(value, keys, code = 'QUOTE_SCHEMA_INVALID') {
  requireCondition(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), code);
}
export function identifier(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/[\x00-\x20\x7f\u202a-\u202e\u2066-\u2069]/.test(value); }
export function assetId(value) {
  if (typeof value !== 'string' || !/^[-a-z0-9]{3,8}:[-a-zA-Z0-9_]{1,32}\/[a-z0-9-]{3,8}:[-.%a-zA-Z0-9]{1,128}$/.test(value)) return false;
  // EVM ERC-20 identity is canonical lowercase. Other namespaces are case-sensitive.
  if (value.startsWith('eip155:') && value.includes('/erc20:')) return /^eip155:[1-9][0-9]*\/erc20:0x[0-9a-f]{40}$/.test(value) && !value.endsWith('0x' + '0'.repeat(40));
  return true;
}
export function assertContext(context) {
  record(context, ['requestId', 'sourceAsset', 'destinationAsset', 'amountIn'], 'CONTEXT_INVALID');
  requireCondition(identifier(context.requestId) && assetId(context.sourceAsset) && assetId(context.destinationAsset) && context.sourceAsset !== context.destinationAsset, 'CONTEXT_INVALID'); amount(context.amountIn, true);
}
export function ceilRatio(value, numerator, denominator) {
  amount(value); amount(numerator, true); amount(denominator, true);
  return (value * numerator + denominator - 1n) / denominator;
}
export function rankExactInputQuotes(context, quotes, rates, policy) {
  assertContext(context);
  record(policy, ['now', 'minimumLifetimeMs', 'maximumSeconds', 'maximumPriceImpactBps', 'allowedRiskClasses', 'requireTrackedFinality'], 'POLICY_INVALID');
  safeInteger(policy.now, 1, Number.MAX_SAFE_INTEGER - 86400000, 'POLICY_INVALID');
  safeInteger(policy.minimumLifetimeMs, 0, 300000, 'POLICY_INVALID');
  if (policy.maximumSeconds !== null) safeInteger(policy.maximumSeconds, 0, 604800, 'POLICY_INVALID');
  if (policy.maximumPriceImpactBps !== null) safeInteger(policy.maximumPriceImpactBps, 0, 10000, 'POLICY_INVALID');
  requireCondition(typeof policy.requireTrackedFinality === 'boolean' && Array.isArray(policy.allowedRiskClasses) && policy.allowedRiskClasses.length >= 1 &&
    policy.allowedRiskClasses.length <= 32 && policy.allowedRiskClasses.every(identifier) && new Set(policy.allowedRiskClasses).size === policy.allowedRiskClasses.length, 'POLICY_INVALID');
  requireCondition(Array.isArray(quotes) && quotes.length <= 256 && Array.isArray(rates) && rates.length <= 128, 'SEARCH_LIMIT');
  const rateMap = new Map();
  for (const rate of rates) {
    record(rate, ['asset', 'outputAsset', 'numerator', 'denominator', 'asOf', 'expiresAt', 'source'], 'RATE_INVALID');
    requireCondition(assetId(rate.asset) && rate.outputAsset === context.destinationAsset && identifier(rate.source), 'RATE_INVALID');
    amount(rate.numerator, true); amount(rate.denominator, true);
    safeInteger(rate.asOf, 1, Number.MAX_SAFE_INTEGER, 'RATE_INVALID'); safeInteger(rate.expiresAt, rate.asOf + 1, Number.MAX_SAFE_INTEGER, 'RATE_INVALID');
    requireCondition(!rateMap.has(rate.asset), 'DUPLICATE_COST_RATE'); rateMap.set(rate.asset, rate);
  }
  const ids = new Set();
  for (const quote of quotes) {
    requireCondition(identifier(quote?.routeId) && !ids.has(quote.routeId), 'DUPLICATE_OR_INVALID_ROUTE_ID'); ids.add(quote.routeId);
  }
  const ranked = []; const incomplete = []; const rejected = [];
  const cutoff = policy.now + policy.minimumLifetimeMs;
  for (const quote of quotes) {
    try {
      record(quote, ['routeId', 'requestId', 'sourceAsset', 'destinationAsset', 'amountIn', 'expectedOut', 'minimumOut', 'expiresAt',
        'durationSeconds', 'priceImpactBps', 'riskClass', 'finality', 'costs', 'unpricedCosts']);
      requireCondition(quote.requestId === context.requestId && quote.sourceAsset === context.sourceAsset && quote.destinationAsset === context.destinationAsset &&
        quote.amountIn === context.amountIn, 'QUOTE_CONTEXT_CHANGED');
      amount(quote.amountIn, true); amount(quote.expectedOut, true); amount(quote.minimumOut, true);
      requireCondition(quote.minimumOut <= quote.expectedOut, 'QUOTE_OUTPUT_INVALID');
      safeInteger(quote.expiresAt, 1, Number.MAX_SAFE_INTEGER, 'QUOTE_EXPIRY_INVALID');
      requireCondition(quote.expiresAt > cutoff, 'QUOTE_EXPIRED_OR_TOO_SHORT');
      if (quote.durationSeconds !== null) safeInteger(quote.durationSeconds, 0, 604800, 'DURATION_INVALID');
      if (quote.priceImpactBps !== null) safeInteger(quote.priceImpactBps, 0, 10000, 'PRICE_IMPACT_INVALID');
      requireCondition(identifier(quote.riskClass) && policy.allowedRiskClasses.includes(quote.riskClass), 'RISK_CLASS_NOT_ALLOWED');
      requireCondition(['tracked', 'partial', 'none'].includes(quote.finality), 'FINALITY_INVALID');
      requireCondition(!policy.requireTrackedFinality || quote.finality === 'tracked', 'FINALITY_NOT_TRACKED');
      requireCondition(policy.maximumSeconds === null || (quote.durationSeconds !== null && quote.durationSeconds <= policy.maximumSeconds), 'DURATION_POLICY_NOT_MET');
      requireCondition(policy.maximumPriceImpactBps === null || (quote.priceImpactBps !== null && quote.priceImpactBps <= policy.maximumPriceImpactBps), 'PRICE_IMPACT_POLICY_NOT_MET');
      requireCondition(Array.isArray(quote.costs) && quote.costs.length <= 64 && Array.isArray(quote.unpricedCosts) && quote.unpricedCosts.length <= 64 &&
        quote.unpricedCosts.every(x => typeof x === 'string' && x.trim().length > 0 && x.length <= 500), 'COST_SCHEMA_INVALID');
      const costIds = new Set(); const unknown = []; let additionalCostOut = 0n; let validUntil = quote.expiresAt;
      for (const cost of quote.costs) {
        record(cost, ['id', 'asset', 'amount', 'treatment'], 'COST_SCHEMA_INVALID');
        requireCondition(identifier(cost.id) && !costIds.has(cost.id) && assetId(cost.asset) && ['included-in-output', 'additional'].includes(cost.treatment), 'COST_SCHEMA_INVALID');
        costIds.add(cost.id); amount(cost.amount);
        // Pool/bridge fees already removed from the displayed output must NOT be
        // subtracted again. Approval gas, extra native gas, relayer payment etc. are additional.
        if (cost.treatment === 'included-in-output' || cost.amount === 0n) continue;
        if (cost.asset === context.destinationAsset) additionalCostOut += cost.amount;
        else {
          const rate = rateMap.get(cost.asset);
          if (!rate) { unknown.push('COST_RATE_MISSING:' + cost.asset); continue; }
          if (rate.asOf > policy.now || rate.expiresAt <= cutoff) { unknown.push('COST_RATE_STALE_OR_FUTURE:' + cost.asset); continue; }
          additionalCostOut += ceilRatio(cost.amount, rate.numerator, rate.denominator); validUntil = Math.min(validUntil, rate.expiresAt);
        }
      }
      if (quote.unpricedCosts.length || unknown.length) {
        incomplete.push({ routeId: quote.routeId, code: 'COSTS_NOT_COMPARABLE', reasons: [...quote.unpricedCosts, ...unknown] }); continue;
      }
      const score = quote.minimumOut - additionalCostOut;
      requireCondition(score > 0n, 'NO_POSITIVE_NET_OUTPUT');
      ranked.push({ routeId: quote.routeId, minimumOut: quote.minimumOut, additionalCostOut, score, validUntil, durationSeconds: quote.durationSeconds });
    } catch (error) { rejected.push({ routeId: quote.routeId, code: error instanceof Error ? error.message : 'QUOTE_INVALID' }); }
  }
  ranked.sort((a, b) => a.score !== b.score ? a.score > b.score ? -1 : 1 :
    (a.durationSeconds ?? Number.MAX_SAFE_INTEGER) - (b.durationSeconds ?? Number.MAX_SAFE_INTEGER) || (a.routeId < b.routeId ? -1 : 1));
  return { objective: 'minimum-out-minus-additional-costs', bestRouteId: ranked[0]?.routeId ?? null, ranked, incomplete, rejected,
    coverage: incomplete.length || rejected.length ? 'incomplete' : 'all-supplied-quotes-comparable',
    optimality: 'best-among-comparable-supplied-quotes', globalOptimality: false, executable: false };
}

/** Explicit bridge from existing src/routing/RouteQuote values, with no implicit
 * fee treatment. Run assertBoundQuote immediately before this and before execution.
 * Unknown costs remain unknown; this function cannot price them or approve them. */
export function adaptBoundRouteQuote(route, request, quote, { riskClass, costTreatments, additionalCosts = [] }) {
  requireCondition(Array.isArray(costTreatments) && costTreatments.length === quote.fees.length &&
    costTreatments.every(t => ['included-in-output', 'additional'].includes(t)), 'ALL_FEE_TREATMENTS_REQUIRED');
  requireCondition(quote.routeId === route.id && quote.amountInBaseUnits === request.amountInBaseUnits, 'QUOTE_CONTEXT_CHANGED');
  return { routeId: quote.routeId, requestId: quote.requestFingerprint, sourceAsset: request.sourceAsset, destinationAsset: request.destinationAsset,
    amountIn: quote.amountInBaseUnits, expectedOut: quote.expectedOutBaseUnits, minimumOut: quote.minimumOutBaseUnits,
    expiresAt: quote.expiresAt, durationSeconds: quote.estimatedSeconds, priceImpactBps: quote.priceImpactBps ?? null,
    riskClass, finality: route.finalityTracking,
    costs: [...quote.fees.map((fee, i) => ({ id: 'bound-fee-' + i, asset: fee.asset, amount: fee.amountBaseUnits, treatment: costTreatments[i] })), ...additionalCosts],
    unpricedCosts: [...quote.unpricedCosts] };
}
