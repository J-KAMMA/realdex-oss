import type { ExactInputContext } from './quote-objective.mjs';
export type GridSample = { steps: number; minimumOut: bigint; additionalCostOut: bigint; expiresAt: number };
export type DiscreteRoute = { routeId: string; requestId: string; sourceAsset: string; destinationAsset: string;
  snapshotId: string; poolIds: readonly string[]; samples: readonly (GridSample | null)[] };
export type SplitOptions = { now: number; quantum: bigint; maximumSplits: number; snapshotId: string; fixedExecutionCostOut: bigint };
export type Allocation = { routeId: string; amountIn: bigint; steps: number; minimumOut: bigint; additionalCostOut: bigint };
export type SplitPlan = { score: bigint; minimumOut: bigint; additionalCostOut: bigint; validUntil: number; allocations: Allocation[];
  requestId: string; snapshotId: string; amountIn: bigint; quantum: bigint };
export type SplitResult = { executable: false; globalOptimality: false; optimality: 'exact-within-supplied-disjoint-quote-grid'; transitions: number } &
  ({ state: 'proposal-only'; plan: SplitPlan } | { state: 'no-positive-net-plan'; plan: null });
export declare function constantProductOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBasisPoints: number): bigint;
export declare function optimizeDiscreteSplit(context: ExactInputContext, routes: readonly DiscreteRoute[], options: SplitOptions): SplitResult;
