import type { BridgeQuote, BridgeRoute, BridgeStage, BridgeTransfer, ChainFamily, RouteCategory } from "./types";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";

const ALLOWED_TRANSITIONS: Record<BridgeStage, readonly BridgeStage[]> = {
  configuring: ["quote-ready", "failed"],
  "quote-ready": ["awaiting-approval", "awaiting-source-wallet", "configuring", "failed"],
  "awaiting-approval": ["awaiting-source-wallet", "quote-ready", "failed"],
  "awaiting-source-wallet": ["source-submitted", "quote-ready", "failed"],
  "source-submitted": ["source-finalized", "delayed", "unknown", "failed"],
  "source-finalized": ["awaiting-proof", "destination-submitted", "refundable", "delayed", "unknown", "failed"],
  "awaiting-proof": ["destination-submitted", "destination-finalized", "refundable", "delayed", "unknown", "failed"],
  "destination-submitted": ["destination-finalized", "delayed", "unknown", "failed"],
  "destination-finalized": [],
  delayed: ["awaiting-proof", "destination-submitted", "destination-finalized", "refundable", "unknown", "failed"],
  refundable: ["source-submitted", "failed"],
  failed: ["configuring"],
  unknown: ["source-finalized", "awaiting-proof", "destination-submitted", "destination-finalized", "refundable", "delayed", "failed"]
};

export function classifyRoute(source: ChainFamily, destination: ChainFamily): RouteCategory {
  if (source === "evm" && destination === "evm") return "evm-to-evm";
  if (source === "evm" || destination === "evm") return "evm-to-non-evm";
  return "non-evm-to-non-evm";
}

export function routeFingerprint(route: BridgeRoute): string {
  return cryptographicFingerprint("realdex.legacy-bridge-route.v2", {
    id: route.id, revision: route.revision, category: route.category, status: route.status, provider: route.provider,
    mechanism: route.mechanism, verificationModel: route.verificationModel, source: route.source, destination: route.destination,
    sourceEndpoint: route.sourceEndpoint.toLowerCase(), destinationEndpoint: route.destinationEndpoint.toLowerCase(),
    supportedAssets: route.supportedAssets, requiredSourceFinality: route.requiredSourceFinality,
    requiredDestinationFinality: route.requiredDestinationFinality, recovery: route.recovery,
    reviewedAt: route.reviewedAt, evidenceUrls: route.evidenceUrls.slice().sort()
  });
}

export function assertExecutableRoute(route: BridgeRoute, now = Date.now()): void {
  if (route.status !== "verified") throw new Error("ROUTE_NOT_VERIFIED");
  if (route.category !== classifyRoute(route.source.family, route.destination.family)) throw new Error("ROUTE_CATEGORY_MISMATCH");
  if (!route.sourceEndpoint || !route.destinationEndpoint) throw new Error("ROUTE_ENDPOINT_MISSING");
  if (route.source.id === route.destination.id) throw new Error("ROUTE_SAME_CHAIN");
  if (route.evidenceUrls.length === 0) throw new Error("ROUTE_EVIDENCE_MISSING");
  const reviewedAt = Date.parse(route.reviewedAt);
  if (!Number.isFinite(reviewedAt) || reviewedAt > now) throw new Error("ROUTE_REVIEW_DATE_INVALID");
}

export function assertFreshQuote(route: BridgeRoute, quote: BridgeQuote, now = Date.now()): void {
  assertExecutableRoute(route, now);
  if (quote.routeId !== route.id || quote.routeFingerprint !== routeFingerprint(route)) throw new Error("QUOTE_ROUTE_CHANGED");
  if (quote.expiresAt <= now) throw new Error("QUOTE_EXPIRED");
  if (quote.amountInBaseUnits <= 0n || quote.minimumOutBaseUnits <= 0n) throw new Error("QUOTE_AMOUNT_INVALID");
  if (!quote.recipient) throw new Error("QUOTE_RECIPIENT_MISSING");
}

export function transitionTransfer(transfer: BridgeTransfer, next: BridgeStage, detail?: string, now = Date.now()): BridgeTransfer {
  if (!ALLOWED_TRANSITIONS[transfer.stage].includes(next)) throw new Error(`INVALID_BRIDGE_TRANSITION:${transfer.stage}->${next}`);
  return { ...transfer, stage: next, detail, lastUpdatedAt: now };
}

export function canSubmitTransfer(route: BridgeRoute | undefined, quote: BridgeQuote | undefined, activeTransfer?: BridgeTransfer, now = Date.now()): boolean {
  if (!route || !quote) return false;
  if (activeTransfer && !["failed", "destination-finalized"].includes(activeTransfer.stage)) return false;
  try { assertFreshQuote(route, quote, now); return true; } catch { return false; }
}
