// Compile only. This does not authenticate an oracle, request or live quote.
import { rankExactInputQuotes, adaptBoundRouteQuote, type QuotePolicy, type ExactInputContext } from '../optimizer/quote-objective.mjs';
import { optimizeDiscreteSplit, constantProductOut } from '../optimizer/discrete-split.mjs';
const context: ExactInputContext = { requestId: 'typed-test', sourceAsset: 'eip155:1/slip44:60', destinationAsset: 'eip155:1/erc20:0x' + '1'.repeat(40), amountIn: 10n };
const policy: QuotePolicy = { now: 1, minimumLifetimeMs: 0, maximumSeconds: null, maximumPriceImpactBps: null, allowedRiskClasses: ['test'], requireTrackedFinality: true };
const ranking = rankExactInputQuotes(context, [], [], policy);
const mustNotExecute: false = ranking.executable;
const typedAmount: bigint = constantProductOut(10n, 100n, 100n, 30);
// @ts-expect-error money is never a Number
constantProductOut(10, 100n, 100n, 30);
// @ts-expect-error grid quantum is a bigint
optimizeDiscreteSplit(context, [], { now: 1, quantum: 1, maximumSplits: 2, snapshotId: 'test', fixedExecutionCostOut: 0n });
void adaptBoundRouteQuote; void mustNotExecute; void typedAmount;
