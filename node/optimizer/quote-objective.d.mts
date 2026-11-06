/** Pure comparison types. A ranked result is NOT execution authorization. */
export type AssetType = string;
export type ExactInputContext = { requestId: string; sourceAsset: AssetType; destinationAsset: AssetType; amountIn: bigint };
export type CostTreatment = 'included-in-output' | 'additional';
export type Cost = { id: string; asset: AssetType; amount: bigint; treatment: CostTreatment };
export type ExactInputQuote = ExactInputContext & {
  routeId: string; expectedOut: bigint; minimumOut: bigint; expiresAt: number;
  durationSeconds: number | null; priceImpactBps: number | null; riskClass: string;
  finality: 'tracked' | 'partial' | 'none'; costs: readonly Cost[]; unpricedCosts: readonly string[];
};
/** numerator/denominator converts smallest input units to smallest output units. */
export type CostRate = { asset: AssetType; outputAsset: AssetType; numerator: bigint; denominator: bigint; asOf: number; expiresAt: number; source: string };
export type QuotePolicy = { now: number; minimumLifetimeMs: number; maximumSeconds: number | null;
  maximumPriceImpactBps: number | null; allowedRiskClasses: readonly string[]; requireTrackedFinality: boolean };
export type RankedQuote = { routeId: string; minimumOut: bigint; additionalCostOut: bigint; score: bigint; validUntil: number; durationSeconds: number | null };
export type QuoteRanking = {
  objective: 'minimum-out-minus-additional-costs'; bestRouteId: string | null; ranked: RankedQuote[];
  incomplete: { routeId: string; code: string; reasons: string[] }[]; rejected: { routeId: string; code: string }[];
  coverage: 'incomplete' | 'all-supplied-quotes-comparable'; optimality: 'best-among-comparable-supplied-quotes'; globalOptimality: false; executable: false;
};
export declare const UINT256_MAX: bigint;
export declare function requireCondition(ok: unknown, code: string): asserts ok;
export declare function amount(value: bigint, positive?: boolean): bigint;
export declare function safeInteger(value: number, min: number, max: number, code: string): void;
export declare function record(value: unknown, keys: string[], code?: string): void;
export declare function identifier(value: unknown): value is string;
export declare function assetId(value: unknown): value is AssetType;
export declare function assertContext(context: ExactInputContext): void;
export declare function ceilRatio(value: bigint, numerator: bigint, denominator: bigint): bigint;
export declare function rankExactInputQuotes(context: ExactInputContext, quotes: readonly ExactInputQuote[], rates: readonly CostRate[], policy: QuotePolicy): QuoteRanking;
/** Caller must separately use src/routing/engine.assertBoundQuote. These shapes
 * are structural subsets of the existing types, avoiding new runtime dependencies. */
export type BoundRouteShape = { id: string; finalityTracking: 'tracked' | 'partial' | 'none' };
export type BoundRequestShape = { sourceAsset: string; destinationAsset: string; amountInBaseUnits: bigint };
export type BoundQuoteShape = { routeId: string; requestFingerprint: string; amountInBaseUnits: bigint;
  expectedOutBaseUnits: bigint; minimumOutBaseUnits: bigint; expiresAt: number; estimatedSeconds: number | null;
  priceImpactBps?: number; fees: readonly { asset: string; amountBaseUnits: bigint }[]; unpricedCosts: readonly string[] };
export declare function adaptBoundRouteQuote(route: BoundRouteShape, request: BoundRequestShape, quote: BoundQuoteShape,
  options: { riskClass: string; costTreatments: readonly CostTreatment[]; additionalCosts?: readonly Cost[] }): ExactInputQuote;
