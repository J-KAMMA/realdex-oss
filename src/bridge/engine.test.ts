import { describe, expect, it } from "vitest";
import { assertExecutableRoute, assertFreshQuote, canSubmitTransfer, classifyRoute, routeFingerprint, transitionTransfer } from "./engine";
import type { BridgeQuote, BridgeRoute, BridgeTransfer, ChainRef } from "./types";

const evm: ChainRef = { id: "eip155:1", name: "Ethereum", family: "evm", nativeAsset: "ETH", addressFormat: "0x", finalityLabel: "finalized" };
const svm: ChainRef = { id: "solana:mainnet", name: "Solana", family: "solana", nativeAsset: "SOL", addressFormat: "base58", finalityLabel: "finalized" };

function route(status: BridgeRoute["status"] = "verified"): BridgeRoute {
  return {
    id: "test-route", revision: 1, category: "evm-to-non-evm", status, provider: "test-only",
    mechanism: "burn-mint", verificationModel: "guardian-attestation", source: evm, destination: svm,
    sourceEndpoint: "0x1111111111111111111111111111111111111111", destinationEndpoint: "Program111",
    supportedAssets: [], requiredSourceFinality: "finalized", requiredDestinationFinality: "finalized",
    recovery: "manual-claim", reviewedAt: "2026-08-01T00:00:00.000Z", evidenceUrls: ["https://example.invalid/spec"]
  };
}

function quoteFor(selected: BridgeRoute, expiresAt = Date.now() + 60_000): BridgeQuote {
  return {
    id: "quote-1", routeId: selected.id, routeFingerprint: routeFingerprint(selected),
    sourceAsset: { chainId: evm.id, assetId: "0xToken", symbol: "TKN", decimals: 18, representation: "native" },
    destinationAsset: { chainId: svm.id, assetId: "Mint", symbol: "TKN", decimals: 9, representation: "native" },
    amountInBaseUnits: 1_000n, minimumOutBaseUnits: 900n, fees: [], recipient: "Recipient", expiresAt, estimatedSeconds: null
  };
}

describe("bridge engine", () => {
  it("classifies all three route families", () => {
    expect(classifyRoute("evm", "evm")).toBe("evm-to-evm");
    expect(classifyRoute("evm", "solana")).toBe("evm-to-non-evm");
    expect(classifyRoute("cosmos", "bitcoin")).toBe("non-evm-to-non-evm");
  });

  it("fails closed for unverified routes and stale or mutated quotes", () => {
    expect(() => assertExecutableRoute(route("experimental"))).toThrow("ROUTE_NOT_VERIFIED");
    const selected = route();
    expect(routeFingerprint(selected)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => assertFreshQuote(selected, quoteFor(selected, Date.now() - 1))).toThrow("QUOTE_EXPIRED");
    const changed = { ...selected, revision: 2 };
    expect(() => assertFreshQuote(changed, quoteFor(selected))).toThrow("QUOTE_ROUTE_CHANGED");
    expect(() => assertFreshQuote({ ...selected, recovery: "none" }, quoteFor(selected))).toThrow("QUOTE_ROUTE_CHANGED");
  });

  it("rejects skipped lifecycle stages and duplicate active submission", () => {
    const selected = route();
    const quote = quoteFor(selected);
    const transfer: BridgeTransfer = { transferId: "x", stage: "source-submitted", quote, sourceTxId: "0x1", lastUpdatedAt: Date.now() };
    expect(() => transitionTransfer(transfer, "destination-finalized")).toThrow("INVALID_BRIDGE_TRANSITION");
    expect(canSubmitTransfer(selected, quote, transfer)).toBe(false);
    expect(canSubmitTransfer(selected, quote)).toBe(true);
  });
});
