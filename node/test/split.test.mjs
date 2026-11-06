import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeDiscreteSplit, constantProductOut } from '../optimizer/discrete-split.mjs';
import { runOptimizerDemo } from '../optimizer/demo-data.mjs';
import { NOW, context, nativeAsset } from './fixtures.mjs';
const ctx = { ...context, amountIn: 10n };
const options = { now: NOW, quantum: 1n, maximumSplits: 2, snapshotId: 'snapshot-a', fixedExecutionCostOut: 0n };
const route = (id, minimum = k => BigInt(k * 10), charge = 0n, steps = 10) => ({ routeId: id, requestId: ctx.requestId,
  sourceAsset: ctx.sourceAsset, destinationAsset: ctx.destinationAsset, snapshotId: options.snapshotId, poolIds: [id],
  samples: Array.from({ length: steps }, (_, i) => ({ steps: i + 1, minimumOut: minimum(i + 1), additionalCostOut: charge, expiresAt: NOW + 60000 })) });

test('constant-product arithmetic matches an independently written rational expression', () => {
  for (const fee of [1, 5, 30, 100]) for (const input of [1n, 10n, 1000n, 9007199254740993n]) {
    const x = 100000000000000000000n; const y = 200000000000000000000n;
    assert.equal(constantProductOut(input, x, y, fee), input * (10000n - BigInt(fee)) * y / (x * 10000n + input * (10000n - BigInt(fee))));
  }
  assert.throws(() => constantProductOut(1n, 0n, 1n, 30)); assert.throws(() => constantProductOut(1n, 1n, 1n, 0));
  assert.throws(() => constantProductOut(1n << 255n, 1000000n, 1000000n, 30), /OVERFLOW/);
});
test('synthetic demo conserves all input and improves the defined net objective', () => {
  const demo = runOptimizerDemo(NOW); const p = demo.split.plan;
  assert.equal(p.allocations.reduce((sum, x) => sum + x.amountIn, 0n), 100000n);
  assert.equal(p.score, 94854n); assert.equal(demo.ranking.ranked[0].score, 90767n);
  assert.ok(p.score > demo.ranking.ranked[0].score); assert.equal(p.additionalCostOut, 225n);
  assert.equal(demo.split.executable, false); assert.equal(demo.split.globalOptimality, false);
});
test('no split wins when activated-route gas exceeds any benefit', () => {
  const result = optimizeDiscreteSplit(ctx, [route('a', k => BigInt(k * 10), 50n), route('b', k => BigInt(k * 10), 50n)], options);
  assert.equal(result.plan.allocations.length, 1); assert.equal(result.plan.score, 50n);
});
test('fixed execution overhead is charged exactly once and absent when no plan exists', () => {
  const result = optimizeDiscreteSplit(ctx, [route('a')], { ...options, fixedExecutionCostOut: 7n });
  assert.equal(result.plan.score, 93n); assert.equal(result.plan.additionalCostOut, 7n);
  assert.equal(optimizeDiscreteSplit(ctx, [route('a')], { ...options, fixedExecutionCostOut: 101n }).state, 'no-positive-net-plan');
});
test('ties prefer fewer routes and remain stable when input route order changes', () => {
  const a = optimizeDiscreteSplit(ctx, [route('a'), route('b')], options);
  const b = optimizeDiscreteSplit(ctx, [route('b'), route('a')], options);
  assert.equal(a.plan.allocations.length, 1); assert.deepEqual(a.plan, b.plan);
});
test('dynamic programming equals exhaustive enumeration over 80 seeded irregular integer grids', () => {
  let seed = 12648430;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let experiment = 0; experiment < 80; experiment++) {
    const K = 2 + random() % 6; const count = 2 + random() % 3; const cap = 1 + random() % Math.min(4, count);
    const input = { ...ctx, amountIn: BigInt(K) }; const fixed = BigInt(random() % 10);
    const routes = Array.from({ length: count }, (_, i) => route('route-' + i, () => 1n + BigInt(random() % 100), BigInt(random() % 20), K));
    // Exhaustive independent oracle. It assumes neither concavity nor monotonically
    // improving sampled output, covering rounding and non-concave fee tables too.
    let brute = null;
    function walk(index, remaining, used, score) {
      if (index === count) { if (remaining === 0 && used > 0 && used <= cap && (brute === null || score > brute)) brute = score; return; }
      for (let take = 0; take <= remaining; take++) {
        const cell = take ? routes[index].samples[take - 1] : null;
        walk(index + 1, remaining - take, used + Number(take > 0), score + (cell ? cell.minimumOut - cell.additionalCostOut : 0n));
      }
    }
    walk(0, K, 0, 0n);
    const actual = optimizeDiscreteSplit(input, routes, { ...options, maximumSplits: cap, fixedExecutionCostOut: fixed });
    if (brute <= fixed) assert.equal(actual.plan, null);
    else { assert.equal(actual.plan.score, brute - fixed); assert.equal(actual.plan.allocations.reduce((s, x) => s + x.amountIn, 0n), BigInt(K)); }
  }
});
test('explicitly unavailable grid cells are not silently usable zero-cost routes', () => {
  const a = route('a'); a.samples[9] = null;
  assert.equal(optimizeDiscreteSplit(ctx, [a], options).plan, null);
});
for (const [label, alter, expected] of [
  ['shared pools', rs => { rs[1].poolIds = [...rs[0].poolIds]; }, 'OVERLAPPING_POOLS_NOT_SUPPORTED'],
  ['duplicate route', rs => { rs[1].routeId = rs[0].routeId; }, 'SPLIT_ROUTE_DUPLICATE'],
  ['mismatched snapshot', rs => { rs[0].snapshotId = 'old'; }, 'SPLIT_CONTEXT_MISMATCH'],
  ['mismatched intent', rs => { rs[0].requestId = 'other-account'; }, 'SPLIT_CONTEXT_MISMATCH'],
  ['missing grid cell', rs => { rs[0].samples.pop(); }, 'QUOTE_GRID_INCOMPLETE'],
  ['wrong grid position', rs => { rs[0].samples[0].steps = 2; }, 'GRID_STEP_MISMATCH'],
  ['expired sample', rs => { rs[0].samples[0].expiresAt = NOW; }, 'SAMPLE_EXPIRED'],
  ['negative sampled cost', rs => { rs[0].samples[0].additionalCostOut = -1n; }, 'AMOUNT_INVALID'],
  ['empty pool identities', rs => { rs[0].poolIds = []; }, 'POOL_RESOURCES_REQUIRED']
]) test('split rejects ' + label, () => {
  const routes = [route('a'), route('b')]; alter(routes); assert.throws(() => optimizeDiscreteSplit(ctx, routes, options), new RegExp(expected));
});
test('off-grid input is rejected instead of dropping input remainder', () => {
  assert.throws(() => optimizeDiscreteSplit({ ...ctx, amountIn: 11n }, [route('a')], { ...options, quantum: 2n }), /AMOUNT_NOT_ON_GRID/);
});
test('cross-chain splitting cannot imply atomicity across a bridge', () => {
  assert.throws(() => optimizeDiscreteSplit({ ...ctx, destinationAsset: nativeAsset.replace('84532', '421614') }, [route('a')], options), /CROSS_CHAIN_SPLIT_NOT_SUPPORTED/);
});
test('route/step/split-count limits bound search work', () => {
  assert.throws(() => optimizeDiscreteSplit({ ...ctx, amountIn: 129n }, [route('a')], options), /GRID_LIMIT/);
  assert.throws(() => optimizeDiscreteSplit(ctx, Array.from({ length: 9 }, (_, i) => route('x' + i)), options), /SPLIT_ROUTE_LIMIT/);
  assert.throws(() => optimizeDiscreteSplit(ctx, [route('a')], { ...options, maximumSplits: 5 }), /SPLIT_COUNT_INVALID/);
});
