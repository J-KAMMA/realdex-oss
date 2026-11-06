import { rankExactInputQuotes } from './quote-objective.mjs';
import { constantProductOut, optimizeDiscreteSplit } from './discrete-split.mjs';
export function runOptimizerDemo(now = Date.now()) {
  const sourceAsset = 'eip155:84532/erc20:0x' + '1'.repeat(40);
  const destinationAsset = 'eip155:84532/erc20:0x' + '2'.repeat(40);
  const context = { requestId: 'synthetic-no-wallet', sourceAsset, destinationAsset, amountIn: 100000n };
  const pools = [{ id: 'demo-pool-a', reserveIn: 1000000n, reserveOut: 1000000n, fee: 30 },
    { id: 'demo-pool-b', reserveIn: 1000000n, reserveOut: 1000000n, fee: 5 }];
  const quotes = pools.map(pool => {
    const minimumOut = constantProductOut(context.amountIn, pool.reserveIn, pool.reserveOut, pool.fee);
    return { ...context, routeId: pool.id, expectedOut: minimumOut, minimumOut, expiresAt: now + 60000, durationSeconds: 3,
      priceImpactBps: 950, riskClass: 'synthetic', finality: 'tracked', costs: [{ id: 'synthetic-extra-gas', asset: destinationAsset, amount: 100n, treatment: 'additional' }], unpricedCosts: [] };
  });
  const ranking = rankExactInputQuotes(context, quotes, [], { now, minimumLifetimeMs: 1000, maximumSeconds: 60,
    maximumPriceImpactBps: 1000, allowedRiskClasses: ['synthetic'], requireTrackedFinality: true });
  const routes = pools.map(pool => ({ routeId: pool.id, requestId: context.requestId, sourceAsset, destinationAsset,
    snapshotId: 'synthetic-fixed-reserves', poolIds: [pool.id], samples: Array.from({ length: 100 }, (_, i) => ({ steps: i + 1,
      minimumOut: constantProductOut(BigInt(i + 1) * 1000n, pool.reserveIn, pool.reserveOut, pool.fee), additionalCostOut: 100n, expiresAt: now + 60000 })) }));
  const split = optimizeDiscreteSplit(context, routes, { now, quantum: 1000n, maximumSplits: 2, snapshotId: 'synthetic-fixed-reserves', fixedExecutionCostOut: 25n });
  return { synthetic: true, notLivePrices: true, notATransaction: true, ranking, split };
}
