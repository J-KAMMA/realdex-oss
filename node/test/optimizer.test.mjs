import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptBoundRouteQuote, amount, ceilRatio, rankExactInputQuotes, UINT256_MAX } from '../optimizer/quote-objective.mjs';
import { NOW, context, nativeAsset, policy, quote, rate, cost } from './fixtures.mjs';
const rank = (quotes, rates = [], change = {}) => rankExactInputQuotes(context, quotes, rates, { ...policy, ...change });

test('larger headline output loses when extra gas reduces net receipt', () => {
  const result = rank([quote('large', { expectedOut: 1200n, minimumOut: 1100n, costs: [cost({ amount: 200n })] }), quote('small', { costs: [cost({ amount: 20n })] })]);
  assert.equal(result.bestRouteId, 'small'); assert.equal(result.ranked[0].score, 980n); assert.equal(result.executable, false); assert.equal(result.globalOptimality, false);
});
test('embedded LP/bridge fees are not double-subtracted', () => {
  const result = rank([quote('a', { costs: [cost({ amount: 500n, treatment: 'included-in-output', asset: nativeAsset })] })]);
  assert.equal(result.ranked[0].score, 1000n);
});
test('non-output asset costs are converted upward using exact rational integer arithmetic', () => {
  const result = rank([quote('a', { costs: [cost({ asset: nativeAsset, amount: 10n })] })], [rate({ numerator: 1n, denominator: 3n })]);
  assert.equal(result.ranked[0].additionalCostOut, 4n); assert.equal(result.ranked[0].score, 996n);
  assert.equal(ceilRatio(9007199254740993n, 3n, 2n), 13510798882111490n);
});
test('missing cost conversion stays incomparable rather than winning as zero cost', () => {
  const result = rank([quote('unknown', { expectedOut: 2000n, minimumOut: 1800n, costs: [cost({ asset: nativeAsset })] }), quote('known')]);
  assert.equal(result.bestRouteId, 'known'); assert.equal(result.incomplete[0].routeId, 'unknown'); assert.equal(result.coverage, 'incomplete');
});
for (const changes of [{ expiresAt: NOW + 1000 }, { asOf: NOW + 1 }, { expiresAt: NOW - 1, asOf: NOW - 10000 }]) {
  test('stale, too-short-lived or future conversion cannot rank', () => {
    const result = rank([quote('a', { costs: [cost({ asset: nativeAsset })] })], [rate(changes)]);
    assert.equal(result.ranked.length, 0); assert.match(result.incomplete[0].reasons[0], /COST_RATE_STALE_OR_FUTURE/);
  });
}
test('validity is bounded by the used rate and zero-valued costs require no rate', () => {
  const result = rank([quote('a', { costs: [cost({ asset: nativeAsset })] })], [rate({ expiresAt: NOW + 10001 })]);
  assert.equal(result.ranked[0].validUntil, NOW + 10001);
  assert.equal(rank([quote('b', { costs: [cost({ asset: nativeAsset, amount: 0n })] })]).bestRouteId, 'b');
});
test('unpriced costs from a local adapter cannot be silently erased by the comparator', () => {
  assert.equal(rank([quote('a', { unpricedCosts: ['Destination mint gas is not yet priced'] })]).incomplete.length, 1);
});
test('duplicate route ids and duplicate rates stop the entire ambiguous comparison', () => {
  assert.throws(() => rank([quote(), quote()]), /DUPLICATE/);
  assert.throws(() => rank([], [rate(), rate()]), /DUPLICATE/);
});
for (const [name, changes, code] of [
  ['request', { requestId: 'changed-recipient-session-intent' }, 'QUOTE_CONTEXT_CHANGED'],
  ['amount', { amountIn: 1001n }, 'QUOTE_CONTEXT_CHANGED'],
  ['asset', { destinationAsset: nativeAsset }, 'QUOTE_CONTEXT_CHANGED'],
  ['expiry', { expiresAt: NOW + 1000 }, 'QUOTE_EXPIRED_OR_TOO_SHORT'],
  ['unsafe output', { minimumOut: 1200n }, 'QUOTE_OUTPUT_INVALID'],
  ['zero output', { minimumOut: 0n }, 'AMOUNT_INVALID'],
  ['float money', { expectedOut: 1100 }, 'AMOUNT_INVALID'],
  ['unapproved bridge risk', { riskClass: 'unreviewed-bridge' }, 'RISK_CLASS_NOT_ALLOWED'],
  ['partial finality', { finality: 'partial' }, 'FINALITY_NOT_TRACKED'],
  ['unknown duration', { durationSeconds: null }, 'DURATION_POLICY_NOT_MET'],
  ['slow duration', { durationSeconds: 61 }, 'DURATION_POLICY_NOT_MET'],
  ['unknown impact', { priceImpactBps: null }, 'PRICE_IMPACT_POLICY_NOT_MET'],
  ['high impact', { priceImpactBps: 1001 }, 'PRICE_IMPACT_POLICY_NOT_MET'],
  ['extra execution grant', { executable: true }, 'QUOTE_SCHEMA_INVALID'],
  ['nonfinite expiry', { expiresAt: NaN }, 'QUOTE_EXPIRY_INVALID'],
  ['negative cost', { costs: [cost({ amount: -1n })] }, 'AMOUNT_INVALID'],
  ['cost exceeds receipt', { costs: [cost({ amount: 1001n })] }, 'NO_POSITIVE_NET_OUTPUT'],
  ['unknown fee treatment', { costs: [cost({ treatment: 'free' })] }, 'COST_SCHEMA_INVALID'],
  ['repeated cost identity', { costs: [cost(), cost()] }, 'COST_SCHEMA_INVALID']
]) test('rejects ' + name, () => { const result = rank([quote('a', changes)]); assert.equal(result.rejected[0].code, code); assert.equal(result.bestRouteId, null); });
test('relaxed constraints must be explicitly supplied, never inferred from a high quote', () => {
  const result = rank([quote('a', { riskClass: 'issuer-attestation', finality: 'partial', durationSeconds: null, priceImpactBps: null })], [],
    { requireTrackedFinality: false, maximumSeconds: null, maximumPriceImpactBps: null, allowedRiskClasses: ['issuer-attestation'] });
  assert.equal(result.bestRouteId, 'a'); assert.equal(result.executable, false);
});
test('ties are stable by duration then route id', () => {
  assert.equal(rank([quote('z'), quote('a')]).bestRouteId, 'a');
  assert.equal(rank([quote('z', { durationSeconds: 1 }), quote('a')]).bestRouteId, 'z');
});
test('money boundaries and empty searches are explicit', () => {
  assert.throws(() => amount(UINT256_MAX + 1n), /AMOUNT_INVALID/); assert.throws(() => amount(Infinity), /AMOUNT_INVALID/);
  assert.equal(rank([]).bestRouteId, null);
});
test('legacy adapter bridge requires every fee treatment and retains unknown gas', () => {
  const route = { id: 'local', finalityTracking: 'tracked' };
  const request = { sourceAsset: context.sourceAsset, destinationAsset: context.destinationAsset, amountInBaseUnits: 1000n };
  const bound = { routeId: 'local', requestFingerprint: context.requestId, amountInBaseUnits: 1000n, expectedOutBaseUnits: 1100n, minimumOutBaseUnits: 1000n,
    expiresAt: NOW + 60000, estimatedSeconds: 10, fees: [{ asset: context.sourceAsset, amountBaseUnits: 5n }], unpricedCosts: ['unpriced gas'] };
  assert.throws(() => adaptBoundRouteQuote(route, request, bound, { riskClass: 'local-amm', costTreatments: [] }), /ALL_FEE_TREATMENTS_REQUIRED/);
  const adapted = adaptBoundRouteQuote(route, request, bound, { riskClass: 'local-amm', costTreatments: ['included-in-output'] });
  assert.deepEqual(adapted.unpricedCosts, ['unpriced gas']); assert.equal(adapted.costs[0].treatment, 'included-in-output');
});
