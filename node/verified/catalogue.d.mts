export type FactoryCandidate = Readonly<{chainId: string; address: string; protocol: 'realdex-cpmm-v1'}>;
export type CatalogueCandidate = FactoryCandidate & Readonly<{sources: readonly {publicKey: string; revision: number; expiresAt: number}[]}>;
export type VerifiedCatalogueResult = Readonly<{schema: 'realdex.verified-catalogue.v1'; relayPublicKey: string; observedAt: number; expiresAt: number; candidates: CatalogueCandidate[]; rejected: {publicKey: string; code: string}[]; executable: false}>;
export declare function challenge(): string;
export declare function readBoundedJson(response: Response, maximumBytes?: number): Promise<unknown>;
export declare function safeEndpoint(value: string, options?: {base?: string; sameOrigin?: boolean}): URL;
/** Browser anti-rollback state is session-local; no keys are auto-trusted. */
export declare class VerifiedCatalogue {
  constructor(options: {relayPublicKey: string; publisherKeys: readonly string[]; now?: ()=>number});
  verify(value: unknown, nonce: string): Promise<VerifiedCatalogueResult>;
  pull(baseEndpoint: string, options?: {fetchImpl?: typeof globalThis.fetch; signal?: AbortSignal; timeoutMs?: number; base?: string; sameOrigin?: boolean}): Promise<VerifiedCatalogueResult>;
}
