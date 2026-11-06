import { describe, expect, it } from "vitest";
import { BUILT_IN_ASSETS } from "../universe/registry";
import { assertBoundQuote, assertRouteDescriptor, executeRouteQuote, quoteRoutes, routeDescriptorFingerprint, routeRequestFingerprint } from "./engine";
import { ROUTE_DESCRIPTORS } from "./registry";
import type { RouteDescriptor, RouteQuote, RouteQuoteRequest, UniversalQuoteAdapter, UniversalRouteAdapter } from "./types";
import { createProviderBindingGrant } from "../wallet/capabilities";

const source = "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const destination = "eip155:421614/erc20:0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const route: RouteDescriptor = {
  id: "route-a", revision: 1, operation: "bridge", adapterId: "mock", sourceAsset: source, destinationAsset: destination,
  state: "ready", walletCapabilityIds: ["eip1193"], sourceExecutionTarget: "0x4444444444444444444444444444444444444444", executionMethod: "depositForBurn", maximumQuoteTtlMs: 120_000, finalityTracking: "partial",
  trustBoundary: "test adapter", evidenceUrls: ["https://example.invalid/evidence"]
};
const request: RouteQuoteRequest = {
  executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000001",
  sourceAsset: source, destinationAsset: destination, amountInBaseUnits: 1_000_000n,
  accountId: "eip155:84532:0x1111111111111111111111111111111111111111", recipient: "0x2222222222222222222222222222222222222222",
  walletCapabilityId: "eip1193", sessionRevision: 2,
  walletGrant: createProviderBindingGrant({ transportId: "test:alpha", accountId: "eip155:84532:0x1111111111111111111111111111111111111111", walletCapabilityId: "eip1193", sessionRevision: 2, expiresAt: Date.now() + 120_000 }), slippageBps: 50
};

function quoteFor(selected = route, input = request, minimumOut = 990_000n, now = Date.now()): RouteQuote {
  return {
    quoteId: `${selected.id}-quote`, routeId: selected.id, routeFingerprint: routeDescriptorFingerprint(selected), requestFingerprint: routeRequestFingerprint(input),
    adapterId: selected.adapterId, amountInBaseUnits: input.amountInBaseUnits, expectedOutBaseUnits: 995_000n, minimumOutBaseUnits: minimumOut,
    fees: [{ kind: "bridge", asset: source, amountBaseUnits: 5_000n, estimated: false }], unpricedCosts: [], expiresAt: now + 60_000, estimatedSeconds: 45,
    authorization: { type: "approval", spender: "0x3333333333333333333333333333333333333333", amountBaseUnits: input.amountInBaseUnits, expiresAt: now + 60_000 },
    executionPreview: { chainId: "eip155:84532", target: "0x4444444444444444444444444444444444444444", method: "depositForBurn", valueBaseUnits: 0n },
    adapterData: { format: "mock.v1", value: {} }
  };
}

function adapter(id = "mock", minimumOut = 990_000n): UniversalQuoteAdapter {
  return { adapterId: id, supports: (candidate) => candidate.adapterId === id, quote: async (candidate, input) => quoteFor(candidate, input, minimumOut) };
}

describe("universal route quote engine", () => {
  it("registers unique direct routes using only reviewed asset identities", () => {
    const assets = new Set(BUILT_IN_ASSETS.map((asset) => asset.assetType));
    expect(new Set(ROUTE_DESCRIPTORS.map((candidate) => candidate.id)).size).toBe(ROUTE_DESCRIPTORS.length);
    for (const candidate of ROUTE_DESCRIPTORS) {
      expect(() => assertRouteDescriptor(candidate)).not.toThrow();
      expect(assets.has(candidate.sourceAsset)).toBe(true);
      expect(assets.has(candidate.destinationAsset)).toBe(true);
    }
  });

  it("fails closed when the exact adapter is not installed", async () => {
    const result = await quoteRoutes(request, [route], []);
    expect(result.quotes).toHaveLength(0);
    expect(result.rejected).toEqual([{ routeId: route.id, code: "ADAPTER_NOT_INSTALLED", detail: undefined }]);
  });

  it("binds quotes to route, account, recipient, session, amount, and expiry", () => {
    const now = Date.now();
    expect(routeDescriptorFingerprint(route)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(routeRequestFingerprint(request)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(routeDescriptorFingerprint({ ...route, trustBoundary: "changed boundary" })).not.toBe(routeDescriptorFingerprint(route));
    expect(routeRequestFingerprint({ ...request, recipient: "0x5555555555555555555555555555555555555555" })).not.toBe(routeRequestFingerprint(request));
    expect(routeRequestFingerprint({ ...request, executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000099" })).not.toBe(routeRequestFingerprint(request));
    expect(() => assertBoundQuote(route, request, quoteFor(route, request, 990_000n, now), now)).not.toThrow();
    expect(() => assertBoundQuote(route, { ...request, sessionRevision: 3 }, quoteFor(route, request, 990_000n, now), now)).toThrow("WALLET_GRANT_REVISION_CHANGED");
    expect(() => assertBoundQuote(route, request, { ...quoteFor(route, request, 990_000n, now), expiresAt: now - 1 }, now)).toThrow("QUOTE_EXPIRY_INVALID");
    expect(() => assertBoundQuote(route, request, { ...quoteFor(route, request, 990_000n, now), quoteId: " bad quote " }, now)).toThrow("QUOTE_ID_INVALID");
    expect(() => assertBoundQuote(route, { ...request, executionIntentId: "caller-chosen" }, quoteFor(route, request, 990_000n, now), now)).toThrow("EXECUTION_INTENT_ID_INVALID");
  });

  it("rejects unsupported wallet capabilities and unsafe descriptors", async () => {
    const walletResult = await quoteRoutes({ ...request, walletCapabilityId: "unsupported-wallet" }, [route], [adapter()]);
    expect(walletResult.rejected[0].code).toBe("WALLET_CAPABILITY_UNSUPPORTED");
    const gatedResult = await quoteRoutes(request, [{ ...route, state: "design-gate" }], [adapter()]);
    expect(gatedResult.rejected[0].code).toBe("ROUTE_NOT_EXECUTABLE");
  });

  it("ranks comparable quotes by minimum received and then duration", async () => {
    const routeB = { ...route, id: "route-b", adapterId: "mock-b" };
    const result = await quoteRoutes(request, [route, routeB], [adapter("mock", 990_000n), adapter("mock-b", 992_000n)]);
    expect(result.quotes.map((quote) => quote.routeId)).toEqual(["route-b", "route-a"]);
  });

  it("rejects a bridge receipt that claims pending without recoverable finality identity", async () => {
    const selected = { ...route, id: "route-receipt-no-finality", adapterId: "mock-no-finality" };
    const quote = quoteFor(selected);
    const untrusted: UniversalRouteAdapter = {
      adapterId: selected.adapterId,
      supports: (candidate) => candidate.id === selected.id,
      quote: async () => quote,
      connectAccount: async () => request.accountId,
      execute: async () => ({ executionId: "provider-operation-1", quoteId: quote.quoteId, state: "pending", provider: "Untrusted bridge", steps: [{ name: "Submit", state: "submitted" }] })
    };
    await expect(executeRouteQuote(selected, request, quote, [untrusted])).rejects.toThrow("EXECUTION_FINALITY_IDENTITY_MISSING");
  });

  it("rejects finality evidence bound to a different route fingerprint", async () => {
    const selected = { ...route, id: "route-receipt-wrong-finality", adapterId: "mock-wrong-finality" };
    const quote = quoteFor(selected);
    const now = Date.now();
    const untrusted: UniversalRouteAdapter = {
      adapterId: selected.adapterId,
      supports: (candidate) => candidate.id === selected.id,
      quote: async () => quote,
      connectAccount: async () => request.accountId,
      execute: async () => ({
        executionId: "provider-operation-2",
        quoteId: quote.quoteId,
        state: "pending",
        provider: "Untrusted bridge",
        steps: [{ name: "Submit", state: "submitted" }],
        finality: {
          schema: "localswap.finality.v1",
          executionId: "provider-operation-2",
          quoteId: quote.quoteId,
          routeId: selected.id,
          routeFingerprint: `0x${"0".repeat(64)}`,
          provider: "Untrusted bridge",
          stage: "source-submitted",
          cursor: { protocol: "cctp-v2", sourceDomain: 6, destinationDomain: 3, sourceTxCandidates: [`0x${"a".repeat(64)}`] },
          evidence: [],
          revision: 1,
          createdAt: now,
          updatedAt: now
        }
      })
    };
    await expect(executeRouteQuote(selected, request, quote, [untrusted])).rejects.toThrow("EXECUTION_FINALITY_IDENTITY_MISMATCH");
  });
});
