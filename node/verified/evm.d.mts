import type { PinnedReadSession, BlockAnchor, AdvisoryGasEstimate } from './rpc.mjs';
import type { FactoryCandidate } from './catalogue.mjs';
import type { CostRate, QuoteRanking } from '../optimizer/quote-objective.mjs';
import type { SplitResult } from '../optimizer/discrete-split.mjs';
declare const observationBrand: unique symbol;
declare const simulationBrand: unique symbol;
export declare const FACTORY_RUNTIME_HASH: string;
export declare const MAX_RESERVE: bigint;
export type DiscoveryRequest = Readonly<{requestId: string; chainId: string; tokenIn: string; tokenOut: string; amountIn: bigint; slippageBps: number; feeTiers: readonly number[]}>;
export type ObservedPool = Readonly<{routeId: string; factory: string; pool: string; feeBps: number; token0: string; token1: string;
  reserveIn: bigint; reserveOut: bigint; expectedOut: bigint; minimumOut: bigint; priceImpactBps: number; runtimeHash: string;
  tokenCodeHashes: Readonly<{input: string; output: string}>}>;
export type PoolObservation = Readonly<{readonly [observationBrand]: never; schema: 'realdex.pool-observation.v1'; factoryRuntimeHash: string;
  request: DiscoveryRequest; anchor: BlockAnchor; readerIds: readonly string[]; pools: readonly ObservedPool[];
  rejected: readonly Readonly<{factory: string; feeBps: number | null; code: string}>[]; expiresAt: number; executable: false;
  tokenTransferBehaviorVerified: false; poolCreationProvenanceVerified: false; poolRuntimeIdentityVerified: false; trust: 'agreement-of-configured-rpcs-not-light-client-proof'}>;
export type ReadonlySimulation = Readonly<{readonly [simulationBrand]: never; schema: 'realdex.readonly-simulation.v1'; routeId: string; requestId: string;
  account: string; recipient: string; blockHash: string; gas: AdvisoryGasEstimate; expiresAt: number; executable: false; warning: string}>;
/** Caller attests completeness. This module does not authenticate an oracle/fee provider. */
export type NetworkFeeAttestation = Readonly<{schema: 'realdex.network-fee-attestation.v1'; routeId: string; requestId: string; blockHash: string;
  account: string; recipient: string; asOf: number; expiresAt: number; complete: boolean; source: string;
  costs: readonly Readonly<{id: string; asset: string; amount: bigint}>[]}>;
export type ObservedComparison = QuoteRanking & {costEvidence: 'caller-attested-network-fees-and-conversion-rates-not-oracle-verified'; futureFeeGuarantee: false};
export type GrossSplitResult = SplitResult & {objective: 'gross-minimum-output-excluding-all-network-costs'; netOptimality: false; costsExcluded: true;
  coverage: 'all-observed-pools-on-requested-grid'; selectedPoolCount: number};
export declare function uintWord(value: bigint): string;
export declare function addressWord(value: string): string;
export declare function encodeCall(signature: string, words?: readonly string[]): string;
export declare function decodeWords(value: string, count: number): bigint[];
export declare function decodeAddress(value: string): string;
export declare function parseDiscoveryRequest(value: DiscoveryRequest): DiscoveryRequest;
/** localPolicy is caller-owned compiled trust policy, never a peer/RPC/form value.
 * The shipped UI and CLI always use the bundled default Factory runtime hash. */
export declare function observeLocalPools(session: PinnedReadSession, candidates: readonly FactoryCandidate[], request: DiscoveryRequest,
  localPolicy?: Readonly<{factoryRuntimeHash: string}>): Promise<PoolObservation>;
export declare function assertCurrentObservation(observation: PoolObservation): PoolObservation;
export declare function recheckObservation(observation: PoolObservation): Promise<PoolObservation>;
export declare function simulateObservedPool(observation: PoolObservation, routeId: string, options: {account: string; recipient: string}): Promise<ReadonlySimulation>;
export declare function compareObservedPools(observation: PoolObservation, options?: {simulations?: readonly ReadonlySimulation[]; rates?: readonly CostRate[];
  nativeAsset?: string; networkFeeEvidence?: readonly NetworkFeeAttestation[]}): ObservedComparison;
export declare function planObservedGrossSplit(observation: PoolObservation, options?: {steps?: number; maximumSplits?: number}): GrossSplitResult;
/** JSON is non-authorizing evidence; it cannot be rehydrated as an issued observation. */
export declare function observationJson(observation: PoolObservation): string;
