export type ReadMethod = 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getCode' | 'eth_call' | 'eth_estimateGas' | 'eth_gasPrice';
export interface RpcReader { readonly id: string; readonly displayId?: string; send(method: ReadMethod, params: readonly unknown[]): Promise<unknown>; }
export type ReadPolicy = { confirmations: number; maxAgeMs: number; ttlMs: number; maxHeadGap: number };
export type BlockAnchor = Readonly<{chainId: string; number: bigint; hash: string; timestampMs: number; observedAt: number; expiresAt: number; confirmations: number}>;
export type EvmCall = Readonly<{to: string; data: string; from?: string; value?: string}>;
export type AdvisoryGasEstimate = Readonly<{gasUnits: bigint; gasPriceWei: bigint; method: 'max-of-rpc-estimates-at-bracketed-block-number'; asOf: number; expiresAt: number}>;
export declare function quantity(value: string): bigint;
export declare function rpcHex(value: string, maximumBytes?: number): string;
export declare function createReadOnlyRpc(endpoint: string, options?: {fetchImpl?: typeof globalThis.fetch; timeoutMs?: number; signal?: AbortSignal}): RpcReader;
/** Endpoint agreement is not consensus or proof of operator independence. */
export declare class PinnedReadSession {
  private constructor();
  readonly anchor: BlockAnchor;
  readonly readerIds: string[];
  time(): number;
  read(method: 'eth_getCode', params: readonly [string]): Promise<string>;
  read(method: 'eth_call', params: readonly [EvmCall]): Promise<string>;
  verifyCurrent(): Promise<true>;
  estimateGas(transaction: EvmCall): Promise<AdvisoryGasEstimate>;
}
export declare function openPinnedReadSession(options: {readers: readonly RpcReader[]; chainId: string; now?: ()=>number; signal?: AbortSignal; policy?: Partial<ReadPolicy>}): Promise<PinnedReadSession>;
