import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { verifySolanaSwapBoundary, type SolanaSwapIntent, type VerifiedSolanaSwap } from "./solana-swap-boundary";
import {
  createSplTokenSwapExactInDecoder,
  createSplTokenSwapExactInVenue,
  validateSplTokenSwapExactInRouteDescriptor,
  type SplTokenSwapExactInRouteDescriptor
} from "./spl-token-swap-exact-in-decoder";
import { verifySplTokenSwapQuote, type VerifiedSplTokenSwapQuote } from "./spl-token-swap-quote-boundary";
import { createPolicyBoundSolanaReaders, type VerifiedSolanaReadPolicy } from "./solana-read-policy";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import {
  solanaVenueSourceFingerprint,
  validateSolanaVenueSource,
  type SolanaVenueSourceDescriptor
} from "./solana-venue-source";

const MAX_ROUTES = 64;
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const verifiedSwaps = new WeakMap<object, string>();

export const SOLANA_SPL_ROUTE_SOURCE_GATE_ID = "solana-signed-spl-token-swap-route-source-v1";

export type SignedSolanaSplRouteManifest = {
  schema: "realdex.signed-solana-spl-routes.v1";
  sourceId: string;
  sourceFingerprint: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  routes: SplTokenSwapExactInRouteDescriptor[];
  evidenceUrls: string[];
  signature: string;
};

export type SolanaSplRouteSourceHead = { revision: number; payloadHash: string };

export type VerifiedSolanaSplRouteManifest = {
  status: "verified-design-gate";
  executionEnabled: false;
  submissionEnabled: false;
  source: SolanaVenueSourceDescriptor;
  sourceFingerprint: string;
  manifest: SignedSolanaSplRouteManifest;
  routes: SplTokenSwapExactInRouteDescriptor[];
  routeFingerprints: string[];
  payloadHash: string;
};

export type VerifiedSourceBoundSplTokenSwap = VerifiedSolanaSwap & {
  sourceFingerprint: string;
  manifestPayloadHash: string;
  routeFingerprint: string;
  readPolicySourceFingerprint: string;
  readPolicyPayloadHash: string;
  quote: VerifiedSplTokenSwapQuote;
  executionEnabled: false;
  submissionEnabled: false;
};

export function canonicalSignedSolanaSplRouteManifestPayload(value: Omit<SignedSolanaSplRouteManifest, "signature">): string {
  return `RealDEX signed Solana SPL Token Swap route manifest v1\n${JSON.stringify(validateUnsignedManifest(value))}`;
}

export async function verifySignedSolanaSplRouteManifest(
  value: unknown,
  sourceValue: unknown,
  options: { now?: number; previousHead?: SolanaSplRouteSourceHead } = {}
): Promise<VerifiedSolanaSplRouteManifest> {
  const source = validateSolanaVenueSource(sourceValue);
  const root = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "routes", "evidenceUrls", "signature"], "SOLANA_SPL_ROUTE_MANIFEST_INVALID");
  if (!isSignature(root.signature)) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_SIGNATURE_INVALID");
  const { signature, ...unsignedValue } = root;
  const unsigned = validateUnsignedManifest(unsignedValue);
  const sourceFingerprint = await solanaVenueSourceFingerprint(source);
  if (unsigned.sourceId !== source.id || unsigned.sourceFingerprint !== sourceFingerprint) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_SOURCE_MISMATCH");

  const now = options.now ?? Date.now();
  const issuedAt = parseCanonicalTimestamp(unsigned.issuedAt, "SOLANA_SPL_ROUTE_MANIFEST_ISSUED_AT_INVALID");
  const expiresAt = parseCanonicalTimestamp(unsigned.expiresAt, "SOLANA_SPL_ROUTE_MANIFEST_EXPIRES_AT_INVALID");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_FROM_FUTURE");
  if (expiresAt <= now) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_VALIDITY_INVALID");
  if (unsigned.routes.some((route) => !source.allowedChainIds.includes(route.chainId))) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_CHAIN_NOT_ALLOWED");

  const routeFingerprints = await Promise.all(unsigned.routes.map(solanaSplRouteFingerprint));
  if (new Set(unsigned.routes.map((route) => route.venueId)).size !== unsigned.routes.length || new Set(routeFingerprints).size !== routeFingerprints.length) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_ROUTE_DUPLICATE");

  const payloadBytes = new TextEncoder().encode(canonicalSignedSolanaSplRouteManifestPayload(unsigned));
  const payloadHash = await sha256Hex(payloadBytes);
  let valid = false;
  try { valid = ed25519.verify(base58.decode(signature as string), payloadBytes, base58.decode(source.signerPublicKey)); }
  catch { throw new Error("SOLANA_SPL_ROUTE_MANIFEST_SIGNATURE_INVALID"); }
  if (!valid) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_SIGNER_NOT_PINNED");

  if (options.previousHead) {
    const head = options.previousHead;
    if (!Number.isSafeInteger(head.revision) || head.revision <= 0 || !/^[0-9a-f]{64}$/.test(head.payloadHash)) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_HEAD_INVALID");
    if (unsigned.revision < head.revision) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_ROLLBACK_BLOCKED");
    if (unsigned.revision === head.revision && payloadHash !== head.payloadHash) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_REVISION_CONFLICT");
  }

  return {
    status: "verified-design-gate", executionEnabled: false, submissionEnabled: false,
    source, sourceFingerprint, manifest: { ...unsigned, signature: signature as string }, routes: unsigned.routes, routeFingerprints, payloadHash
  };
}

export async function verifySourceBoundSplTokenSwap(input: {
  source: unknown;
  signedManifest: unknown;
  previousHead?: SolanaSplRouteSourceHead;
  venueId: string;
  intent: SolanaSwapIntent;
  readPolicy: VerifiedSolanaReadPolicy;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<VerifiedSourceBoundSplTokenSwap> {
  const verifiedManifest = await verifySignedSolanaSplRouteManifest(input.signedManifest, input.source, { now: input.now, previousHead: input.previousHead });
  const index = verifiedManifest.routes.findIndex((route) => route.venueId === input.venueId);
  if (index < 0) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_ROUTE_NOT_FOUND");
  const route = verifiedManifest.routes[index];
  const policyReaders = await createPolicyBoundSolanaReaders(input.readPolicy, input.now, input.fetchImpl);
  if (policyReaders.policy.policy.chainId !== route.chainId) throw new Error("SOLANA_READ_POLICY_ROUTE_CHAIN_MISMATCH");
  if (policyReaders.policy.source.signerPublicKey === verifiedManifest.source.signerPublicKey) throw new Error("SOLANA_READ_POLICY_REVIEWER_NOT_INDEPENDENT");
  const verifiedQuote = await verifySplTokenSwapQuote({ route, intent: input.intent, readers: policyReaders.quoteReaders, now: input.now });
  const verifiedSwap = await verifySolanaSwapBoundary({
    venue: createSplTokenSwapExactInVenue(route), intent: input.intent, readers: policyReaders.swapReaders,
    decodeSwapInstruction: createSplTokenSwapExactInDecoder(route), now: input.now
  });
  const result: VerifiedSourceBoundSplTokenSwap = {
    ...verifiedSwap, sourceFingerprint: verifiedManifest.sourceFingerprint, manifestPayloadHash: verifiedManifest.payloadHash,
    routeFingerprint: verifiedManifest.routeFingerprints[index], readPolicySourceFingerprint: policyReaders.policy.sourceFingerprint,
    readPolicyPayloadHash: policyReaders.policy.payloadHash, quote: verifiedQuote, executionEnabled: false, submissionEnabled: false
  };
  verifiedSwaps.set(result, cryptographicFingerprint("realdex.verified-source-bound-spl-swap.v1", result));
  return result;
}

/** Source-bound evidence is an in-memory capability, not importable JSON. */
export function assertVerifiedSourceBoundSplTokenSwap(value: VerifiedSourceBoundSplTokenSwap): void {
  const expected = verifiedSwaps.get(value);
  if (!expected) throw new Error("SOLANA_SPL_VERIFIED_SWAP_NOT_AUTHENTIC");
  let current: string;
  try { current = cryptographicFingerprint("realdex.verified-source-bound-spl-swap.v1", value); }
  catch { throw new Error("SOLANA_SPL_VERIFIED_SWAP_CHANGED"); }
  if (current !== expected) throw new Error("SOLANA_SPL_VERIFIED_SWAP_CHANGED");
}

export async function solanaSplRouteFingerprint(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(validateSplTokenSwapExactInRouteDescriptor(value))));
}

function validateUnsignedManifest(value: unknown): Omit<SignedSolanaSplRouteManifest, "signature"> {
  const manifest = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "routes", "evidenceUrls"], "SOLANA_SPL_ROUTE_MANIFEST_INVALID");
  if (manifest.schema !== "realdex.signed-solana-spl-routes.v1" || typeof manifest.sourceId !== "string" || !SOURCE_ID.test(manifest.sourceId) || typeof manifest.sourceFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sourceFingerprint) || !Number.isSafeInteger(manifest.revision) || Number(manifest.revision) <= 0 || typeof manifest.issuedAt !== "string" || typeof manifest.expiresAt !== "string") throw new Error("SOLANA_SPL_ROUTE_MANIFEST_IDENTITY_INVALID");
  if (!Array.isArray(manifest.routes) || manifest.routes.length < 1 || manifest.routes.length > MAX_ROUTES) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_SIZE_INVALID");
  return {
    schema: manifest.schema, sourceId: manifest.sourceId, sourceFingerprint: manifest.sourceFingerprint, revision: Number(manifest.revision),
    issuedAt: manifest.issuedAt, expiresAt: manifest.expiresAt, routes: manifest.routes.map(validateSplTokenSwapExactInRouteDescriptor),
    evidenceUrls: validEvidenceUrls(manifest.evidenceUrls, 1, 32, "SOLANA_SPL_ROUTE_MANIFEST_EVIDENCE_INVALID")
  };
}

function strictObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(code);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) throw new Error(code);
  return object;
}

function validEvidenceUrls(value: unknown, minimum: number, maximum: number, code: string): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || value.some((url) => typeof url !== "string" || !isHttps(url)) || new Set(value).size !== value.length) throw new Error(code);
  return [...value] as string[];
}

function isHttps(value: string): boolean { try { const url = new URL(value); return value.length <= 2_048 && url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }
function isSignature(value: unknown): value is string { try { return typeof value === "string" && base58.decode(value).length === 64; } catch { return false; } }
function parseCanonicalTimestamp(value: string, code: string): number { const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code); return parsed; }
async function sha256Hex(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
