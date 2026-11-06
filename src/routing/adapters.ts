import { assertCctpExecutionAvailable, estimateCctp, executeCctp, type CctpBrowserProviders, type CctpDirection, type CctpEstimate, type CctpExecutionResult } from "../bridge/cctp";
import { createCctpTransferBinding } from "../bridge/cctp-message";
import { estimateIbc, executeIbc, type IbcDirection, type IbcEstimate, type IbcExecutionResult } from "../bridge/ibc";
import { assertRouteDescriptor, assertRouteRequest, routeDescriptorFingerprint, routeRequestFingerprint } from "./engine";
import { createRouteFinalityRecord } from "./finality";
import type { RouteDescriptor, RouteExecutionReceipt, RouteFee, RouteQuote, RouteQuoteRequest, UniversalRouteAdapter } from "./types";

type CctpEstimator = (direction: CctpDirection, amount: string, recipient: string) => Promise<CctpEstimate>;
type IbcEstimator = (direction: IbcDirection, amount: string, recipient: string) => Promise<IbcEstimate>;
type CctpAccountResolver = (direction: CctpDirection, requestAccess?: boolean) => Promise<string>;
type IbcAccountResolver = (direction: IbcDirection) => Promise<string>;
type CctpExecutor = (direction: CctpDirection, amount: string, recipient: string, quote: string, onProgress?: (result: CctpExecutionResult) => void) => Promise<CctpExecutionResult>;
type IbcExecutor = (direction: IbcDirection, amount: string, recipient: string, estimate: IbcEstimate, onProgress?: (result: IbcExecutionResult) => void) => Promise<IbcExecutionResult>;

const CCTP_DIRECTIONS: Record<string, CctpDirection> = {
  "cctp-v2-base-sepolia-solana-devnet-usdc": "base-to-solana",
  "cctp-v2-solana-devnet-base-sepolia-usdc": "solana-to-base",
  "cctp-v2-base-sepolia-arbitrum-sepolia-usdc": "base-to-arbitrum",
  "cctp-v2-arbitrum-sepolia-base-sepolia-usdc": "arbitrum-to-base"
};

const CCTP_DOMAINS: Record<CctpDirection, { sourceDomain: number; destinationDomain: number }> = {
  "base-to-solana": { sourceDomain: 6, destinationDomain: 5 },
  "solana-to-base": { sourceDomain: 5, destinationDomain: 6 },
  "base-to-arbitrum": { sourceDomain: 6, destinationDomain: 3 },
  "arbitrum-to-base": { sourceDomain: 3, destinationDomain: 6 }
};

const IBC_DIRECTIONS: Record<string, IbcDirection> = {
  "ibc-grand-1-osmo-test-5-usdc": "noble-to-osmosis",
  "ibc-osmo-test-5-grand-1-usdc": "osmosis-to-noble"
};

const GAS_ASSETS: Record<string, { asset: string; decimals: number }> = {
  "eip155:84532": { asset: "eip155:84532/slip44:60", decimals: 18 },
  "eip155:421614": { asset: "eip155:421614/slip44:60", decimals: 18 },
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": { asset: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/slip44:501", decimals: 9 },
  "cosmos:grand-1": { asset: "cosmos:grand-1/denom:uusdc", decimals: 6 },
  "cosmos:osmo-test-5": { asset: "cosmos:osmo-test-5/denom:uosmo", decimals: 6 }
};

export function createCctpQuoteAdapter(estimator: CctpEstimator = estimateCctp, accountResolver: CctpAccountResolver = resolveCctpAccount, executor: CctpExecutor = (direction, amount, recipient, quote, onProgress) => executeCctp(direction, amount, recipient, quote, undefined, onProgress), releaseGate: (direction: CctpDirection) => void = assertCctpExecutionAvailable): UniversalRouteAdapter {
  return {
    adapterId: "cctp-v2",
    supports: (route) => route.adapterId === "cctp-v2" && Boolean(CCTP_DIRECTIONS[route.id]),
    connectAccount: async (route) => {
      const direction = CCTP_DIRECTIONS[route.id];
      if (!direction) throw new Error("CCTP_ROUTE_UNSUPPORTED");
      releaseGate(direction);
      return accountResolver(direction, true);
    },
    quote: async (route, request) => {
      assertRouteDescriptor(route); assertRouteRequest(request);
      const direction = CCTP_DIRECTIONS[route.id];
      if (!direction) throw new Error("CCTP_ROUTE_UNSUPPORTED");
      releaseGate(direction);
      const amount = baseUnitsToDecimal(request.amountInBaseUnits, 6);
      const estimate = await estimator(direction, amount, request.recipient);
      const activeAccount = await accountResolver(direction);
      assertSameAccount(request.accountId, activeAccount, route.sourceAsset);
      if (estimate.quoteExpiresAt === null) throw new Error("CCTP_QUOTE_EXPIRY_UNAVAILABLE");
      const now = Date.now();
      const gas = gasAssetFor(route.sourceAsset);
      const fees: RouteFee[] = [];
      const bridgeFee = decimalToBaseUnits(estimate.feeTotal, 6);
      if (bridgeFee > 0n) fees.push({ kind: "bridge", asset: route.sourceAsset, amountBaseUnits: bridgeFee, estimated: false });
      for (const fee of estimate.gasFees) {
        if (!isGasSymbolFor(fee.token, gas.asset)) throw new Error("CCTP_GAS_ASSET_UNSUPPORTED");
        fees.push({ kind: "network", asset: gas.asset, amountBaseUnits: decimalToBaseUnits(fee.amount, gas.decimals), estimated: true });
      }
      return makeQuote(route, request, {
        quoteId: `cctp:${routeRequestFingerprint(request)}:${estimate.quoteExpiresAt}`,
        expectedOutBaseUnits: decimalToBaseUnits(estimate.amountReceived, 6),
        fees,
        expiresAt: Math.min(estimate.quoteExpiresAt, now + route.maximumQuoteTtlMs),
        authorization: { type: "adapter-managed", detail: "Circle Bridge Kit may request an exact USDC approval before the burn transaction." },
        adapterData: { format: "cctp-v2.signed-quote.v1", value: { direction, signedQuote: estimate.quote, estimate } }
      });
    },
    execute: async (route, request, quote, onProgress) => {
      const payload = cctpPayload(quote);
      if (payload.direction !== CCTP_DIRECTIONS[route.id]) throw new Error("CCTP_EXECUTION_DIRECTION_MISMATCH");
      releaseGate(payload.direction);
      assertSameAccount(request.accountId, await accountResolver(payload.direction, false), route.sourceAsset);
      const result = await executor(payload.direction, baseUnitsToDecimal(request.amountInBaseUnits, 6), request.recipient, payload.signedQuote, (progress) => onProgress?.(receiptFromCctp(route, request, quote, progress, payload.direction)));
      return receiptFromCctp(route, request, quote, result, payload.direction);
    }
  };
}

export function createIbcQuoteAdapter(estimator: IbcEstimator = estimateIbc, accountResolver: IbcAccountResolver = resolveIbcAccount, executor: IbcExecutor = executeIbc): UniversalRouteAdapter {
  return {
    adapterId: "ibc-ics20",
    supports: (route) => route.adapterId === "ibc-ics20" && Boolean(IBC_DIRECTIONS[route.id]),
    connectAccount: async (route) => {
      const direction = IBC_DIRECTIONS[route.id];
      if (!direction) throw new Error("IBC_ROUTE_UNSUPPORTED");
      return accountResolver(direction);
    },
    quote: async (route, request) => {
      assertRouteDescriptor(route); assertRouteRequest(request);
      const direction = IBC_DIRECTIONS[route.id];
      if (!direction) throw new Error("IBC_ROUTE_UNSUPPORTED");
      const estimate = await estimator(direction, baseUnitsToDecimal(request.amountInBaseUnits, 6), request.recipient);
      assertSameAccount(request.accountId, `${chainIdOf(route.sourceAsset)}:${estimate.sender}`, route.sourceAsset);
      const gas = gasAssetFor(route.sourceAsset);
      const fee = decimalToBaseUnits(estimate.feeAmount, gas.decimals);
      return makeQuote(route, request, {
        quoteId: `ibc:${routeRequestFingerprint(request)}:${estimate.quoteExpiresAt}`,
        expectedOutBaseUnits: decimalToBaseUnits(estimate.amountReceived, 6),
        fees: fee > 0n ? [{ kind: "network", asset: gas.asset, amountBaseUnits: fee, estimated: true }] : [],
        expiresAt: Math.min(estimate.quoteExpiresAt, Date.now() + route.maximumQuoteTtlMs),
        authorization: { type: "none" },
        adapterData: { format: "ibc-ics20.estimate.v1", value: { direction, estimate } }
      });
    },
    execute: async (route, request, quote, onProgress) => {
      const payload = ibcPayload(quote);
      if (payload.direction !== IBC_DIRECTIONS[route.id]) throw new Error("IBC_EXECUTION_DIRECTION_MISMATCH");
      const result = await executor(payload.direction, baseUnitsToDecimal(request.amountInBaseUnits, 6), request.recipient, payload.estimate, (progress) => onProgress?.(receiptFromIbc(route, quote, progress)));
      return receiptFromIbc(route, quote, result);
    }
  };
}

export function createInstalledQuoteAdapters(providers?: CctpBrowserProviders): UniversalRouteAdapter[] {
  const cctp = providers
    ? createCctpQuoteAdapter(
        (direction, amount, recipient) => estimateCctp(direction, amount, recipient, providers),
        (direction, requestAccess) => resolveCctpAccount(direction, requestAccess, providers),
        (direction, amount, recipient, quote, onProgress) => executeCctp(direction, amount, recipient, quote, providers, onProgress)
      )
    : createCctpQuoteAdapter();
  return [cctp, createIbcQuoteAdapter()];
}

export function expectedBridgeExecutionId(route: RouteDescriptor, quote: RouteQuote): string {
  if (route.operation !== "bridge" || quote.routeId !== route.id || quote.adapterId !== route.adapterId) throw new Error("BRIDGE_EXECUTION_IDENTITY_INVALID");
  if (route.adapterId === "cctp-v2") return `cctp:${quote.quoteId}`;
  if (route.adapterId === "ibc-ics20") return `ibc:${quote.quoteId}`;
  throw new Error("BRIDGE_EXECUTION_IDENTITY_UNSUPPORTED");
}

export function decimalToBaseUnits(value: string, decimals: number): bigint {
  const normalized = value.trim();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) throw new Error("DECIMAL_AMOUNT_INVALID");
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) throw new Error("DECIMAL_PRECISION_EXCEEDED");
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction.padEnd(decimals, "0") || "0"));
}

export function baseUnitsToDecimal(value: bigint, decimals: number): string {
  if (value < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("BASE_UNIT_AMOUNT_INVALID");
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${value / scale}.${fraction}` : (value / scale).toString();
}

function makeQuote(route: RouteDescriptor, request: RouteQuoteRequest, values: Pick<RouteQuote, "quoteId" | "expectedOutBaseUnits" | "fees" | "expiresAt" | "authorization" | "adapterData">): RouteQuote {
  return {
    ...values,
    routeId: route.id,
    routeFingerprint: routeDescriptorFingerprint(route),
    requestFingerprint: routeRequestFingerprint(request),
    adapterId: route.adapterId,
    amountInBaseUnits: request.amountInBaseUnits,
    minimumOutBaseUnits: applySlippage(values.expectedOutBaseUnits, request.slippageBps),
    unpricedCosts: [],
    estimatedSeconds: null,
    executionPreview: { chainId: chainIdOf(route.sourceAsset), target: route.sourceExecutionTarget, method: route.executionMethod, valueBaseUnits: 0n }
  };
}

function applySlippage(value: bigint, slippageBps: number): bigint {
  const minimum = value * BigInt(10_000 - slippageBps) / 10_000n;
  if (minimum <= 0n) throw new Error("QUOTE_MINIMUM_OUT_ZERO");
  return minimum;
}

function gasAssetFor(assetType: string) {
  const gas = GAS_ASSETS[chainIdOf(assetType)];
  if (!gas) throw new Error("GAS_ASSET_UNREGISTERED");
  return gas;
}

function isGasSymbolFor(symbol: string, assetType: string): boolean {
  const normalized = symbol.trim().toUpperCase();
  if (assetType.includes("slip44:60")) return normalized === "ETH";
  if (assetType.includes("slip44:501")) return normalized === "SOL";
  return normalized === "USDC" || normalized === "USDC.N" || normalized === "OSMO";
}

function chainIdOf(assetType: string): string {
  return assetType.slice(0, assetType.indexOf("/"));
}

function assertSameAccount(expected: string, actual: string, sourceAsset: string): void {
  const evm = chainIdOf(sourceAsset).startsWith("eip155:");
  if ((evm ? expected.toLowerCase() : expected) !== (evm ? actual.toLowerCase() : actual)) throw new Error("WALLET_ACCOUNT_CHANGED");
}

async function resolveCctpAccount(direction: CctpDirection, requestAccess = false, selectedProviders?: CctpBrowserProviders): Promise<string> {
  if (direction === "solana-to-base") {
    const providers = (selectedProviders ?? window) as unknown as { solana?: { publicKey?: { toString(): string } }; phantom?: { solana?: { publicKey?: { toString(): string } } } };
    const provider = providers.phantom?.solana ?? providers.solana;
    if (requestAccess && provider && "connect" in provider && typeof provider.connect === "function") await provider.connect();
    const account = provider?.publicKey?.toString();
    if (!account) throw new Error("SOLANA_ACCOUNT_UNAVAILABLE");
    return `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${account}`;
  }
  const provider = (selectedProviders ?? window as unknown as CctpBrowserProviders).ethereum as { request(args: { method: string }): Promise<unknown> } | undefined;
  if (!provider) throw new Error("EVM_ACCOUNT_UNAVAILABLE");
  return resolveEip1193CctpAccount(direction, provider, requestAccess);
}

export async function resolveEip1193CctpAccount(direction: Exclude<CctpDirection, "solana-to-base">, provider: { request(args: { method: string }): Promise<unknown> }, requestAccess = false): Promise<string> {
  const [chainHex, accounts] = await Promise.all([provider.request({ method: "eth_chainId" }), provider.request({ method: requestAccess ? "eth_requestAccounts" : "eth_accounts" })]);
  if (typeof chainHex !== "string" || !/^0x[0-9a-f]+$/i.test(chainHex) || !Array.isArray(accounts) || typeof accounts[0] !== "string" || !/^0x[0-9a-f]{40}$/i.test(accounts[0])) throw new Error("EVM_ACCOUNT_UNAVAILABLE");
  const chainId = Number.parseInt(chainHex, 16);
  const expectedChainId = direction === "arbitrum-to-base" ? 421614 : 84532;
  if (chainId !== expectedChainId) throw new Error("WALLET_NETWORK_CHANGED");
  return `eip155:${chainId}:${accounts[0]}`;
}

async function resolveIbcAccount(direction: IbcDirection): Promise<string> {
  if (!window.keplr || !window.getOfflineSignerAuto) throw new Error("COSMOS_ACCOUNT_UNAVAILABLE");
  const chainId = direction === "noble-to-osmosis" ? "grand-1" : "osmo-test-5";
  await window.keplr.enable(chainId);
  const accounts = await (await window.getOfflineSignerAuto(chainId)).getAccounts();
  const address = accounts[0]?.address;
  if (!address) throw new Error("COSMOS_ACCOUNT_UNAVAILABLE");
  return `cosmos:${chainId}:${address}`;
}

function cctpPayload(quote: RouteQuote): { direction: CctpDirection; signedQuote: string } {
  if (quote.adapterData.format !== "cctp-v2.signed-quote.v1" || !quote.adapterData.value || typeof quote.adapterData.value !== "object") throw new Error("CCTP_EXECUTION_PAYLOAD_INVALID");
  const payload = quote.adapterData.value as { direction?: CctpDirection; signedQuote?: string };
  if (!payload.direction || !payload.signedQuote) throw new Error("CCTP_EXECUTION_PAYLOAD_INVALID");
  return { direction: payload.direction, signedQuote: payload.signedQuote };
}

function ibcPayload(quote: RouteQuote): { direction: IbcDirection; estimate: IbcEstimate } {
  if (quote.adapterData.format !== "ibc-ics20.estimate.v1" || !quote.adapterData.value || typeof quote.adapterData.value !== "object") throw new Error("IBC_EXECUTION_PAYLOAD_INVALID");
  const payload = quote.adapterData.value as { direction?: IbcDirection; estimate?: IbcEstimate };
  if (!payload.direction || !payload.estimate || payload.estimate.quoteExpiresAt !== quote.expiresAt) throw new Error("IBC_EXECUTION_PAYLOAD_INVALID");
  return { direction: payload.direction, estimate: payload.estimate };
}

function receiptFromCctp(route: RouteDescriptor, request: RouteQuoteRequest, quote: RouteQuote, result: CctpExecutionResult, direction: CctpDirection): RouteExecutionReceipt {
  const executionId = expectedBridgeExecutionId(route, quote);
  const sourceTxCandidates = [...new Set(result.steps.flatMap((step) => step.name.trim().toLowerCase() === "burn" && step.txHash && validTransactionId(step.txHash) ? [step.txHash] : []))].slice(0, 8);
  const state = (result.state === "success" || result.state === "pending") && sourceTxCandidates.length ? "pending" : result.state === "error" ? "failed" : "unknown";
  const finality = sourceTxCandidates.length ? createRouteFinalityRecord({
    executionId, quoteId: quote.quoteId, routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route), provider: result.provider,
    stage: result.state === "error" ? "failed" : "source-submitted",
    cursor: { protocol: "cctp-v2", ...CCTP_DOMAINS[direction], sourceTxCandidates, transferBinding: createCctpTransferBinding(route, request) }, evidence: []
  }) : undefined;
  return { executionId, quoteId: quote.quoteId, state, provider: result.provider, steps: result.steps, finality };
}

function receiptFromIbc(route: RouteDescriptor, quote: RouteQuote, result: IbcExecutionResult): RouteExecutionReceipt {
  const executionId = expectedBridgeExecutionId(route, quote);
  const finality = result.tracking ? createRouteFinalityRecord({
    executionId, quoteId: quote.quoteId, routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route), provider: result.provider,
    stage: result.state === "pending" ? "source-included" : "failed",
    cursor: { protocol: "ibc-ics20", ...result.tracking },
    evidence: [{ kind: "source-tx", id: result.tracking.sourceTxHash, observedAt: Date.now(), url: result.steps.find((step) => step.txHash === result.tracking?.sourceTxHash)?.explorerUrl }]
  }) : undefined;
  const failureProof = result.state === "error" && Number.isSafeInteger(result.failureCode) && Number(result.failureCode) > 0 && result.steps.length === 1 && result.steps[0].txHash
    ? { type: "cosmos-source-transaction-failed" as const, transactionHash: result.steps[0].txHash, code: Number(result.failureCode) }
    : undefined;
  return { executionId, quoteId: quote.quoteId, state: result.state === "pending" ? finality ? "pending" : "unknown" : "failed", provider: result.provider, steps: result.steps, finality, failureProof };
}

function validTransactionId(value: string): boolean { return /^0x[0-9a-f]{64}$/i.test(value) || /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value); }
