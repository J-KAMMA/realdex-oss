import type { DiscoveryRequest, PoolObservation, ReadonlySimulation, ObservedComparison } from './evm.mjs';
export type ReadOnlyConfig = Readonly<{schema: 'realdex.readonly-request.v1'; nodeUrl: string; relayPublicKey: string;
  publisherKeys: readonly string[]; rpcUrls: readonly string[]; request: Omit<DiscoveryRequest,'amountIn'> & {readonly amountIn: string}; account: string | null}>;
export type ParsedReadOnlyConfig = Omit<ReadOnlyConfig,'request'> & {readonly request: DiscoveryRequest};
export type JsonData<T> = T extends bigint ? string : T extends readonly (infer U)[] ? JsonData<U>[] : T extends object ?
  { [K in keyof T as K extends symbol ? never : K]: JsonData<T[K]> } : T;
export type ReadOnlyReport = Readonly<{schema: 'realdex.readonly-report.v1'; status: 'observed-no-execution' | 'no-verified-pools';
  observation: JsonData<PoolObservation> & {usage: 'READ_ONLY_EVIDENCE_NOT_A_TRANSACTION_OR_RELEASE_APPROVAL'};
  catalogue: {relayPublicKey: string; candidateCount: number; rejected: {publicKey: string; code: string}[]};
  simulations: ReadonlySimulation[]; simulationErrors: {routeId: string; code: string}[]; comparison: ObservedComparison;
  executable: false; walletSigning: false; usage: 'READ_ONLY_EVIDENCE_NOT_A_TRANSACTION_OR_RELEASE_APPROVAL'}>;
export declare function parseReadOnlyConfig(input: ReadOnlyConfig): ParsedReadOnlyConfig;
export declare function runReadOnlyRequest(input: ReadOnlyConfig, options?: {fetchImpl?: typeof globalThis.fetch; now?: ()=>number; signal?: AbortSignal}): Promise<ReadOnlyReport>;
