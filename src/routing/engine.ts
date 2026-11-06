import { isCaip19 } from "../universe/registry";
import { assertWalletGrant, assertWalletGrantSupportsRoute, walletGrantFingerprint } from "../wallet/capabilities";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { assertRouteExecutionIntentId } from "./execution-intent";
import { clearRouteExecutionGuard, createRouteExecutionGuardRecord, legacyRouteExecutionGuardExists, persistRouteExecutionGuard, persistentExecutionGuardExists, routeExecutionGuardKey, type ExecutionGuardStorage } from "./execution-guard";
import { browserCrossTabExecutionLockManager, withCrossTabExecutionLock } from "./cross-tab-execution-lock";
import type { RouteDescriptor, RouteExecutionReceipt, RouteQuote, RouteQuoteRequest, RouteRejection, RouteSearchResult, UniversalQuoteAdapter, UniversalRouteAdapter } from "./types";

const activeExecutions = new Set<string>();
const retainedExecutionGuards = new Set<string>();

export function routeDescriptorFingerprint(route: RouteDescriptor): string {
  return cryptographicFingerprint("realdex.route-descriptor.v2", {
    id: route.id, revision: route.revision, operation: route.operation, adapterId: route.adapterId,
    sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset, state: route.state,
    walletCapabilityIds: route.walletCapabilityIds.slice().sort(), sourceExecutionTarget: route.sourceExecutionTarget.toLowerCase(),
    executionMethod: route.executionMethod, maximumQuoteTtlMs: route.maximumQuoteTtlMs,
    finalityTracking: route.finalityTracking, trustBoundary: route.trustBoundary, evidenceUrls: route.evidenceUrls.slice().sort()
  });
}

export function routeRequestFingerprint(request: RouteQuoteRequest): string {
  return cryptographicFingerprint("realdex.route-quote-request.v3", {
    executionIntentId: request.executionIntentId,
    sourceAsset: request.sourceAsset, destinationAsset: request.destinationAsset, amountInBaseUnits: request.amountInBaseUnits,
    accountId: request.accountId, recipient: request.recipient, walletCapabilityId: request.walletCapabilityId,
    sessionRevision: request.sessionRevision, walletGrantFingerprint: walletGrantFingerprint(request.walletGrant), slippageBps: request.slippageBps
  });
}

/** Recovery compatibility only. Never use this legacy FNV value as quote or execution authority. */
export function legacyRouteDescriptorFingerprint(route: RouteDescriptor): string {
  return legacyHashText([
    route.id, route.revision, route.operation, route.adapterId, route.sourceAsset,
    route.destinationAsset, route.state, route.walletCapabilityIds.slice().sort().join(","),
    route.sourceExecutionTarget.toLowerCase(), route.executionMethod,
    route.maximumQuoteTtlMs, route.finalityTracking, route.trustBoundary,
    route.evidenceUrls.slice().sort().join(",")
  ].join("|"));
}

export function assertRouteRequest(request: RouteQuoteRequest): void {
  assertRouteExecutionIntentId(request.executionIntentId);
  if (!isCaip19(request.sourceAsset) || !isCaip19(request.destinationAsset)) throw new Error("ROUTE_ASSET_ID_INVALID");
  if (request.sourceAsset === request.destinationAsset) throw new Error("ROUTE_ASSETS_IDENTICAL");
  if (request.amountInBaseUnits <= 0n) throw new Error("ROUTE_AMOUNT_INVALID");
  if (!request.accountId.trim() || !request.recipient.trim()) throw new Error("ROUTE_ACCOUNT_OR_RECIPIENT_MISSING");
  if (!request.accountId.toLowerCase().startsWith(`${chainIdOf(request.sourceAsset).toLowerCase()}:`)) throw new Error("ROUTE_ACCOUNT_CHAIN_MISMATCH");
  if (!request.walletCapabilityId.trim()) throw new Error("ROUTE_WALLET_CAPABILITY_MISSING");
  if (!Number.isInteger(request.sessionRevision) || request.sessionRevision < 0) throw new Error("ROUTE_SESSION_REVISION_INVALID");
  assertWalletGrant(request.walletGrant);
  if (request.walletGrant.revision !== request.sessionRevision) throw new Error("WALLET_GRANT_REVISION_CHANGED");
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 500) throw new Error("ROUTE_SLIPPAGE_OUT_OF_RANGE");
}

export function assertRouteDescriptor(route: RouteDescriptor): void {
  if (!route.id || !route.adapterId || !Number.isInteger(route.revision) || route.revision <= 0) throw new Error("ROUTE_DESCRIPTOR_IDENTITY_INVALID");
  if (!isCaip19(route.sourceAsset) || !isCaip19(route.destinationAsset)) throw new Error("ROUTE_DESCRIPTOR_ASSET_INVALID");
  if (route.sourceAsset === route.destinationAsset) throw new Error("ROUTE_DESCRIPTOR_ASSETS_IDENTICAL");
  if (route.state !== "ready") throw new Error("ROUTE_NOT_EXECUTABLE");
  if (!route.walletCapabilityIds.length) throw new Error("ROUTE_WALLET_CAPABILITY_MISSING");
  if (!route.sourceExecutionTarget.trim() || !route.executionMethod.trim()) throw new Error("ROUTE_EXECUTION_TARGET_MISSING");
  if (route.maximumQuoteTtlMs < 5_000 || route.maximumQuoteTtlMs > 10 * 60_000) throw new Error("ROUTE_QUOTE_TTL_INVALID");
  if (route.finalityTracking === "none") throw new Error("ROUTE_FINALITY_UNTRACKED");
  if (!route.trustBoundary.trim()) throw new Error("ROUTE_TRUST_BOUNDARY_MISSING");
  if (!route.evidenceUrls.length || route.evidenceUrls.some((url) => !isHttps(url))) throw new Error("ROUTE_EVIDENCE_INVALID");
}

export function assertBoundQuote(route: RouteDescriptor, request: RouteQuoteRequest, quote: RouteQuote, now = Date.now()): void {
  assertRouteDescriptor(route);
  assertRouteRequest(request);
  assertWalletGrantSupportsRoute(request.walletGrant, route, request.accountId, request.walletCapabilityId, request.sessionRevision, now);
  if (!quote.quoteId || quote.quoteId.length > 800 || quote.quoteId.trim() !== quote.quoteId || /[\u0000-\u001f\u007f]/.test(quote.quoteId)) throw new Error("QUOTE_ID_INVALID");
  if (quote.routeId !== route.id || quote.adapterId !== route.adapterId) throw new Error("QUOTE_ADAPTER_OR_ROUTE_CHANGED");
  if (quote.routeFingerprint !== routeDescriptorFingerprint(route)) throw new Error("QUOTE_ROUTE_CHANGED");
  if (quote.requestFingerprint !== routeRequestFingerprint(request)) throw new Error("QUOTE_REQUEST_CHANGED");
  if (quote.amountInBaseUnits !== request.amountInBaseUnits) throw new Error("QUOTE_AMOUNT_CHANGED");
  if (quote.expectedOutBaseUnits <= 0n || quote.minimumOutBaseUnits <= 0n || quote.minimumOutBaseUnits > quote.expectedOutBaseUnits) throw new Error("QUOTE_OUTPUT_INVALID");
  if (quote.priceImpactBps !== undefined && (!Number.isInteger(quote.priceImpactBps) || quote.priceImpactBps < 0 || quote.priceImpactBps > 10_000)) throw new Error("QUOTE_PRICE_IMPACT_INVALID");
  if (quote.expiresAt <= now || quote.expiresAt > now + route.maximumQuoteTtlMs) throw new Error("QUOTE_EXPIRY_INVALID");
  if (quote.estimatedSeconds !== null && (!Number.isInteger(quote.estimatedSeconds) || quote.estimatedSeconds < 0)) throw new Error("QUOTE_DURATION_INVALID");
  if (quote.fees.some((fee) => !isCaip19(fee.asset) || fee.amountBaseUnits < 0n)) throw new Error("QUOTE_FEE_INVALID");
  if (quote.unpricedCosts.some((cost) => !cost.trim())) throw new Error("QUOTE_UNPRICED_COST_INVALID");
  if (quote.authorization.type === "approval" && (!quote.authorization.spender || quote.authorization.amountBaseUnits < request.amountInBaseUnits || (quote.authorization.expiresAt !== null && quote.authorization.expiresAt <= now))) throw new Error("QUOTE_APPROVAL_INVALID");
  if (quote.authorization.type === "adapter-managed" && !quote.authorization.detail.trim()) throw new Error("QUOTE_AUTHORIZATION_DETAIL_MISSING");
  if (quote.executionPreview.chainId !== chainIdOf(request.sourceAsset) || quote.executionPreview.target.toLowerCase() !== route.sourceExecutionTarget.toLowerCase() || quote.executionPreview.method !== route.executionMethod || quote.executionPreview.valueBaseUnits < 0n) throw new Error("QUOTE_EXECUTION_PREVIEW_INVALID");
  if (!quote.adapterData.format.trim()) throw new Error("QUOTE_ADAPTER_DATA_INVALID");
}

export async function quoteRoutes(
  request: RouteQuoteRequest,
  routes: readonly RouteDescriptor[],
  adapters: readonly UniversalQuoteAdapter[],
  now?: number
): Promise<RouteSearchResult> {
  assertRouteRequest(request);
  const requestFingerprint = routeRequestFingerprint(request);
  const adapterById = new Map(adapters.map((adapter) => [adapter.adapterId, adapter]));
  const quotes: RouteQuote[] = [];
  const rejected: RouteRejection[] = [];

  for (const route of routes) {
    if (route.sourceAsset !== request.sourceAsset || route.destinationAsset !== request.destinationAsset) continue;
    try {
      assertRouteDescriptor(route);
      assertWalletGrantSupportsRoute(request.walletGrant, route, request.accountId, request.walletCapabilityId, request.sessionRevision, now ?? Date.now());
      const adapter = adapterById.get(route.adapterId);
      if (!adapter || !adapter.supports(route)) throw new Error("ADAPTER_NOT_INSTALLED");
      const quote = await adapter.quote(route, request);
      assertBoundQuote(route, request, quote, now ?? Date.now());
      quotes.push(quote);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "QUOTE_PROVIDER_FAILED";
      rejected.push({ routeId: route.id, code: knownCode(code) ? code : "QUOTE_PROVIDER_FAILED", detail: knownCode(code) ? undefined : code });
    }
  }

  quotes.sort(compareQuotes);
  return { requestFingerprint, quotes, rejected };
}

export async function executeRouteQuote(
  route: RouteDescriptor,
  request: RouteQuoteRequest,
  quote: RouteQuote,
  adapters: readonly UniversalRouteAdapter[],
  now = Date.now(),
  onProgress?: (receipt: RouteExecutionReceipt) => void,
  onBeforeAdapterExecute?: () => void
): Promise<RouteExecutionReceipt> {
  assertBoundQuote(route, request, quote, now);
  const adapter = adapters.find((candidate) => candidate.adapterId === route.adapterId && candidate.supports(route));
  if (!adapter) throw new Error("ADAPTER_NOT_INSTALLED");
  const guardKey = executionGuardKey(route, request);
  const executeInsideLock = async () => {
    const activeAccount = await adapter.connectAccount(route);
    const evm = chainIdOf(request.sourceAsset).startsWith("eip155:");
    if ((evm ? activeAccount.toLowerCase() : activeAccount) !== (evm ? request.accountId.toLowerCase() : request.accountId)) throw new Error("WALLET_ACCOUNT_CHANGED");
    if (activeExecutions.has(guardKey) || persistentGuardExists(guardKey) || persistentLegacyRouteGuardExists(route)) throw new Error("DUPLICATE_ROUTE_EXECUTION");
    activeExecutions.add(guardKey);
    try {
      writePersistentGuard(route, request, quote, now);
      try {
        onBeforeAdapterExecute?.();
      } catch (reason) {
        if (!removePersistentGuard(guardKey)) throw new Error("EXECUTION_GUARD_RELEASE_FAILED");
        throw reason;
      }
      let progressProvider: string | undefined;
      const validatedProgress = onProgress ? (progress: RouteExecutionReceipt) => {
        assertExecutionReceipt(progress, route, quote);
        if (progress.state !== "pending") throw new Error("EXECUTION_PROGRESS_STATE_INVALID");
        if (progressProvider !== undefined && progress.provider !== progressProvider) throw new Error("EXECUTION_PROGRESS_PROVIDER_CHANGED");
        progressProvider = progress.provider;
        onProgress(progress);
      } : undefined;
      const receipt = await adapter.execute(route, request, quote, validatedProgress);
      assertExecutionReceipt(receipt, route, quote);
      if (progressProvider !== undefined && receipt.provider !== progressProvider) throw new Error("EXECUTION_PROGRESS_PROVIDER_CHANGED");
      if (failedReceiptAllowsGuardRelease(receipt, route)) removePersistentGuard(guardKey);
      return receipt;
    } finally {
      activeExecutions.delete(guardKey);
    }
  };
  if (typeof window === "undefined") return executeInsideLock();
  const lockManager = browserCrossTabExecutionLockManager();
  if (!lockManager) throw new Error("EXECUTION_GUARD_CROSS_TAB_LOCK_UNAVAILABLE");
  return withCrossTabExecutionLock(lockManager, guardKey, executeInsideLock);
}

function assertExecutionReceipt(receipt: RouteExecutionReceipt, route: RouteDescriptor, quote: RouteQuote): void {
  if (receipt.quoteId !== quote.quoteId) throw new Error("EXECUTION_RECEIPT_QUOTE_MISMATCH");
  if (!receipt.executionId.trim() || receipt.executionId.length > 800 || !receipt.provider.trim() || receipt.provider.length > 200 || !["pending", "confirmed", "failed", "unknown"].includes(receipt.state)) throw new Error("EXECUTION_RECEIPT_INVALID");
  if (!Array.isArray(receipt.steps) || receipt.steps.length > 32 || receipt.steps.some((step) => !step.name?.trim() || !step.state?.trim() || step.name.length > 200 || step.state.length > 200 || (step.kind !== undefined && !["approval", "swap", "bridge"].includes(step.kind)) || (step.txHash !== undefined && (typeof step.txHash !== "string" || step.txHash.length > 200)) || (step.evmTransaction !== undefined && invalidEvmTransactionEvidence(step.evmTransaction, step.kind, step.txHash, step.evmReceipt)) || (step.evmReceipt !== undefined && step.evmTransaction === undefined) || (step.explorerUrl !== undefined && !isHttps(step.explorerUrl)) || (step.errorMessage !== undefined && (typeof step.errorMessage !== "string" || step.errorMessage.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(step.errorMessage))))) throw new Error("EXECUTION_RECEIPT_STEPS_INVALID");
  assertFailureProofShape(receipt);
  if (!receipt.finality) {
    if (route.operation === "bridge" && (receipt.state === "pending" || receipt.state === "confirmed")) throw new Error("EXECUTION_FINALITY_IDENTITY_MISSING");
    return;
  }
  if (receipt.finality.executionId !== receipt.executionId || receipt.finality.quoteId !== quote.quoteId || receipt.finality.routeId !== route.id || receipt.finality.routeFingerprint !== routeDescriptorFingerprint(route) || receipt.finality.provider !== receipt.provider || receipt.finality.cursor.protocol !== route.adapterId) throw new Error("EXECUTION_FINALITY_IDENTITY_MISMATCH");
  if (receipt.state === "confirmed" && receipt.finality.stage !== "destination-confirmed") throw new Error("EXECUTION_FINALITY_STATE_MISMATCH");
  if (receipt.state === "pending" && ["destination-confirmed", "failed"].includes(receipt.finality.stage)) throw new Error("EXECUTION_FINALITY_STATE_MISMATCH");
}

function assertFailureProofShape(receipt: RouteExecutionReceipt): void {
  const proof = receipt.failureProof;
  if (proof === undefined) return;
  if (receipt.state !== "failed" || !isObject(proof) || typeof proof.type !== "string") throw new Error("EXECUTION_FAILURE_PROOF_INVALID");
  if (proof.type === "no-value-transfer-submitted") {
    if (!exactObjectKeys(proof, ["type"])) throw new Error("EXECUTION_FAILURE_PROOF_INVALID");
    return;
  }
  if (proof.type === "evm-value-transfer-reverted") {
    if (!exactObjectKeys(proof, ["type", "transactionHash"]) || !isTxHash(proof.transactionHash)) throw new Error("EXECUTION_FAILURE_PROOF_INVALID");
    return;
  }
  if (proof.type === "cosmos-source-transaction-failed") {
    if (!exactObjectKeys(proof, ["type", "transactionHash", "code"]) || typeof proof.transactionHash !== "string" || !/^[0-9a-f]{64}$/i.test(proof.transactionHash) || !Number.isSafeInteger(proof.code) || proof.code <= 0 || proof.code > 0xffff_ffff) throw new Error("EXECUTION_FAILURE_PROOF_INVALID");
    return;
  }
  throw new Error("EXECUTION_FAILURE_PROOF_INVALID");
}

function failedReceiptAllowsGuardRelease(receipt: RouteExecutionReceipt, route: RouteDescriptor): boolean {
  if (receipt.state !== "failed" || !receipt.failureProof || receipt.finality) return false;
  const proof = receipt.failureProof;
  if (proof.type === "no-value-transfer-submitted") {
    return receipt.steps.every((step) => !step.txHash || terminalEvmStep(step, "approval"));
  }
  if (proof.type === "evm-value-transfer-reverted") {
    if (route.operation !== "swap" || !chainIdOf(route.sourceAsset).startsWith("eip155:")) return false;
    const submitted = receipt.steps.filter((step) => step.txHash !== undefined);
    if (!submitted.length || !submitted.every((step) => terminalEvmStep(step))) return false;
    const swaps = submitted.filter((step) => step.kind === "swap");
    return swaps.length > 0 && swaps.every((step) => step.evmReceipt?.status === 0) && swaps.some((step) => step.txHash?.toLowerCase() === proof.transactionHash.toLowerCase());
  }
  if (proof.type === "cosmos-source-transaction-failed") {
    if (route.operation !== "bridge" || !chainIdOf(route.sourceAsset).startsWith("cosmos:")) return false;
    const submitted = receipt.steps.filter((step) => step.txHash !== undefined);
    return submitted.length === 1 && submitted[0].state === "failed" && submitted[0].txHash?.toLowerCase() === proof.transactionHash.toLowerCase() && submitted[0].evmTransaction === undefined && submitted[0].evmReceipt === undefined;
  }
  return false;
}

function terminalEvmStep(step: RouteExecutionReceipt["steps"][number], requiredKind?: "approval" | "swap"): boolean {
  if (requiredKind !== undefined && step.kind !== requiredKind) return false;
  if ((step.kind !== "approval" && step.kind !== "swap") || !step.txHash || !step.evmTransaction || !step.evmReceipt) return false;
  return step.evmTransaction.replacement === undefined || step.evmTransaction.replacement.reason === "repriced";
}

export function executionGuardKey(route: RouteDescriptor, request: RouteQuoteRequest): string {
  return routeExecutionGuardKey(routeDescriptorFingerprint(route), request.executionIntentId);
}

function compareQuotes(left: RouteQuote, right: RouteQuote): number {
  if (left.minimumOutBaseUnits !== right.minimumOutBaseUnits) return left.minimumOutBaseUnits > right.minimumOutBaseUnits ? -1 : 1;
  const leftDuration = left.estimatedSeconds ?? Number.MAX_SAFE_INTEGER;
  const rightDuration = right.estimatedSeconds ?? Number.MAX_SAFE_INTEGER;
  return leftDuration - rightDuration || left.routeId.localeCompare(right.routeId);
}

function chainIdOf(assetType: string): string {
  return assetType.slice(0, assetType.indexOf("/"));
}

function isHttps(value: string): boolean {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function knownCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(value);
}

function invalidEvmTransactionEvidence(value: unknown, kind: string | undefined, txHash: string | undefined, receipt: unknown): boolean {
  if ((kind !== "approval" && kind !== "swap") || !isTxHash(txHash) || !isObject(value)) return true;
  const baseKeys = ["from", "to", "nonce", "data", "valueBaseUnits", "chainId", "observedBeforeBlock"];
  const keys = Object.keys(value);
  if (keys.some((key) => ![...baseKeys, "replacement"].includes(key)) || baseKeys.some((key) => !(key in value)) || !isEvmEnvelope(value) || !Number.isSafeInteger(value.observedBeforeBlock) || Number(value.observedBeforeBlock) < 0) return true;
  const replacement = value.replacement;
  if (replacement !== undefined) {
    if (!isObject(replacement) || !exactObjectKeys(replacement, ["from", "to", "nonce", "data", "valueBaseUnits", "chainId", "hash", "reason"]) || !isEvmEnvelope(replacement) || !isTxHash(replacement.hash) || !["repriced", "cancelled", "replaced"].includes(String(replacement.reason))) return true;
  }
  if (receipt !== undefined) {
    if (!isObject(receipt) || !exactObjectKeys(receipt, ["hash", "status", "blockNumber", "blockHash"]) || !isTxHash(receipt.hash) || (receipt.status !== 0 && receipt.status !== 1) || !Number.isSafeInteger(receipt.blockNumber) || Number(receipt.blockNumber) < 0 || !isTxHash(receipt.blockHash)) return true;
    const effectiveHash = isObject(replacement) && typeof replacement.hash === "string" ? replacement.hash : txHash!;
    if (String(receipt.hash).toLowerCase() !== effectiveHash.toLowerCase()) return true;
  }
  return false;
}

function isEvmEnvelope(value: Record<string, unknown>): boolean {
  return isEvmAddress(value.from) && isEvmAddress(value.to) && Number.isSafeInteger(value.nonce) && Number(value.nonce) >= 0 && typeof value.data === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value.data) && value.data.length <= 65_538 && typeof value.valueBaseUnits === "string" && /^(?:0|[1-9]\d*)$/.test(value.valueBaseUnits) && typeof value.chainId === "string" && /^[1-9]\d*$/.test(value.chainId);
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function isEvmAddress(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value); }
function isTxHash(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value); }

function legacyHashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function persistentGuardExists(key: string): boolean {
  if (retainedExecutionGuards.has(key)) return true;
  const storage = executionGuardStorage();
  return storage ? persistentExecutionGuardExists(storage, key) : false;
}

function persistentLegacyRouteGuardExists(route: RouteDescriptor): boolean {
  const storage = executionGuardStorage();
  return storage ? legacyRouteExecutionGuardExists(storage, routeDescriptorFingerprint(route)) || legacyRouteExecutionGuardExists(storage, legacyRouteDescriptorFingerprint(route)) : false;
}

function writePersistentGuard(route: RouteDescriptor, request: RouteQuoteRequest, quote: RouteQuote, createdAt: number): void {
  const record = createRouteExecutionGuardRecord(routeDescriptorFingerprint(route), request.executionIntentId, quote.requestFingerprint, quote.quoteId, createdAt);
  const key = record.guardKey;
  retainedExecutionGuards.add(key);
  const storage = executionGuardStorage();
  if (storage) persistRouteExecutionGuard(storage, record);
  else if (typeof window !== "undefined") throw new Error("EXECUTION_GUARD_PERSISTENCE_UNAVAILABLE");
}

function removePersistentGuard(key: string): boolean {
  const storage = executionGuardStorage();
  if (storage && !clearRouteExecutionGuard(storage, key)) return false;
  retainedExecutionGuards.delete(key);
  return true;
}

function executionGuardStorage(): ExecutionGuardStorage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}
