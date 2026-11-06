import { Secp256k1, Secp256k1Signature, sha256 } from "@cosmjs/crypto";
import { base64 } from "@scure/base";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import {
  verifyCosmosSwapBoundary,
  validateCosmosSwapIntent,
  type CosmosSwapIntent,
  type VerifiedCosmosSwap
} from "./cosmos-swap-boundary";
import {
  createPolicyBoundCosmosReaders,
  type VerifiedCosmosReadPolicy
} from "./cosmos-read-policy";
import {
  createOsmosisExactInDecoder,
  createOsmosisExactInVenue,
  validateOsmosisExactInRouteDescriptor,
  type OsmosisExactInRouteDescriptor
} from "./osmosis-exact-in-decoder";

const MAX_ROUTES = 64;
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const COSMOS_CHAIN = /^cosmos:[-_a-zA-Z0-9]{1,32}$/;
const SECP256K1_HALF_ORDER = BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");
const verifiedSwaps = new WeakMap<object, string>();

export const COSMOS_VENUE_SOURCE_GATE_ID = "cosmos-signed-osmosis-route-source-v1";

export type CosmosVenueSourceDescriptor = {
  schema: "realdex.cosmos-venue-source.v1";
  id: string;
  name: string;
  signerPublicKeyBase64: string;
  allowedChainIds: string[];
  evidenceUrls: string[];
};

export type SignedOsmosisRouteManifest = {
  schema: "realdex.signed-osmosis-routes.v1";
  sourceId: string;
  sourceFingerprint: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  routes: OsmosisExactInRouteDescriptor[];
  evidenceUrls: string[];
  signatureBase64: string;
};

export type CosmosVenueSourceHead = { revision: number; payloadHash: string };

export type VerifiedOsmosisRouteManifest = {
  status: "verified-design-gate";
  executionEnabled: false;
  broadcastEnabled: false;
  source: CosmosVenueSourceDescriptor;
  sourceFingerprint: string;
  manifest: SignedOsmosisRouteManifest;
  routes: OsmosisExactInRouteDescriptor[];
  routeFingerprints: string[];
  payloadHash: string;
};

export type VerifiedSourceBoundOsmosisSwap = VerifiedCosmosSwap & {
  verifiedAt: number;
  expiresAt: number;
  sourceFingerprint: string;
  manifestPayloadHash: string;
  routeFingerprint: string;
  readPolicySourceFingerprint: string;
  readPolicyPayloadHash: string;
  executionEnabled: false;
  broadcastEnabled: false;
};

export function validateCosmosVenueSource(value: unknown): CosmosVenueSourceDescriptor {
  const source = strictObject(value, ["schema", "id", "name", "signerPublicKeyBase64", "allowedChainIds", "evidenceUrls"], "COSMOS_VENUE_SOURCE_INVALID");
  if (source.schema !== "realdex.cosmos-venue-source.v1" || typeof source.id !== "string" || !SOURCE_ID.test(source.id) || typeof source.name !== "string" || !source.name.trim() || source.name.length > 100 || !isCompressedPublicKey(source.signerPublicKeyBase64)) throw new Error("COSMOS_VENUE_SOURCE_IDENTITY_INVALID");
  if (!Array.isArray(source.allowedChainIds) || source.allowedChainIds.length < 1 || source.allowedChainIds.length > 100 || source.allowedChainIds.some((chain) => typeof chain !== "string" || !COSMOS_CHAIN.test(chain)) || new Set(source.allowedChainIds).size !== source.allowedChainIds.length) throw new Error("COSMOS_VENUE_SOURCE_CHAINS_INVALID");
  return {
    schema: source.schema,
    id: source.id,
    name: source.name,
    signerPublicKeyBase64: source.signerPublicKeyBase64 as string,
    allowedChainIds: [...source.allowedChainIds] as string[],
    evidenceUrls: validEvidenceUrls(source.evidenceUrls, 1, 16, "COSMOS_VENUE_SOURCE_EVIDENCE_INVALID")
  };
}

export function cosmosVenueSourceFingerprint(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(validateCosmosVenueSource(value))));
}

export function canonicalSignedOsmosisRouteManifestPayload(value: Omit<SignedOsmosisRouteManifest, "signatureBase64">): string {
  return `RealDEX signed Cosmos/Osmosis route manifest v1\n${JSON.stringify(validateUnsignedManifest(value))}`;
}

export function verifySignedOsmosisRouteManifest(
  value: unknown,
  sourceValue: unknown,
  options: { now?: number; previousHead?: CosmosVenueSourceHead } = {}
): VerifiedOsmosisRouteManifest {
  const source = validateCosmosVenueSource(sourceValue);
  const root = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "routes", "evidenceUrls", "signatureBase64"], "COSMOS_VENUE_MANIFEST_INVALID");
  if (!isCompactSignature(root.signatureBase64)) throw new Error("COSMOS_VENUE_MANIFEST_SIGNATURE_INVALID");
  const { signatureBase64, ...unsignedValue } = root;
  const unsigned = validateUnsignedManifest(unsignedValue);
  const sourceFingerprint = cosmosVenueSourceFingerprint(source);
  if (unsigned.sourceId !== source.id || unsigned.sourceFingerprint !== sourceFingerprint) throw new Error("COSMOS_VENUE_MANIFEST_SOURCE_MISMATCH");

  const now = options.now ?? Date.now();
  const issuedAt = parseCanonicalTimestamp(unsigned.issuedAt, "COSMOS_VENUE_MANIFEST_ISSUED_AT_INVALID");
  const expiresAt = parseCanonicalTimestamp(unsigned.expiresAt, "COSMOS_VENUE_MANIFEST_EXPIRES_AT_INVALID");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("COSMOS_VENUE_MANIFEST_FROM_FUTURE");
  if (expiresAt <= now) throw new Error("COSMOS_VENUE_MANIFEST_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) throw new Error("COSMOS_VENUE_MANIFEST_VALIDITY_INVALID");
  if (unsigned.routes.some((route) => !source.allowedChainIds.includes(route.chainId))) throw new Error("COSMOS_VENUE_MANIFEST_CHAIN_NOT_ALLOWED");

  const routeFingerprints = unsigned.routes.map(osmosisRouteFingerprint);
  if (new Set(unsigned.routes.map((route) => route.venueId)).size !== unsigned.routes.length || new Set(routeFingerprints).size !== routeFingerprints.length) throw new Error("COSMOS_VENUE_MANIFEST_ROUTE_DUPLICATE");

  const payloadBytes = new TextEncoder().encode(canonicalSignedOsmosisRouteManifestPayload(unsigned));
  const payloadHash = sha256Hex(payloadBytes);
  const signatureBytes = base64.decode(signatureBase64 as string);
  const signature = Secp256k1Signature.fromFixedLength(signatureBytes);
  if (bytesToBigInt(signature.s()) > SECP256K1_HALF_ORDER) throw new Error("COSMOS_VENUE_MANIFEST_HIGH_S_SIGNATURE");
  let valid = false;
  try { valid = Secp256k1.verifySignature(signature, sha256(payloadBytes), base64.decode(source.signerPublicKeyBase64)); }
  catch { throw new Error("COSMOS_VENUE_MANIFEST_SIGNATURE_INVALID"); }
  if (!valid) throw new Error("COSMOS_VENUE_MANIFEST_SIGNER_NOT_PINNED");

  if (options.previousHead) {
    const head = options.previousHead;
    if (!Number.isSafeInteger(head.revision) || head.revision <= 0 || !/^[0-9a-f]{64}$/.test(head.payloadHash)) throw new Error("COSMOS_VENUE_MANIFEST_HEAD_INVALID");
    if (unsigned.revision < head.revision) throw new Error("COSMOS_VENUE_MANIFEST_ROLLBACK_BLOCKED");
    if (unsigned.revision === head.revision && payloadHash !== head.payloadHash) throw new Error("COSMOS_VENUE_MANIFEST_REVISION_CONFLICT");
  }

  return {
    status: "verified-design-gate",
    executionEnabled: false,
    broadcastEnabled: false,
    source,
    sourceFingerprint,
    manifest: { ...unsigned, signatureBase64: signatureBase64 as string },
    routes: unsigned.routes,
    routeFingerprints,
    payloadHash
  };
}

export async function verifySourceBoundOsmosisSwap(input: {
  source: unknown;
  signedManifest: unknown;
  previousHead?: CosmosVenueSourceHead;
  venueId: string;
  intent: CosmosSwapIntent;
  readPolicy: VerifiedCosmosReadPolicy;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<VerifiedSourceBoundOsmosisSwap> {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("COSMOS_VERIFIED_SWAP_TIME_INVALID");
  const intent = validateCosmosSwapIntent(input.intent);
  const verifiedManifest = verifySignedOsmosisRouteManifest(input.signedManifest, input.source, { now, previousHead: input.previousHead });
  const index = verifiedManifest.routes.findIndex((route) => route.venueId === input.venueId);
  if (index < 0) throw new Error("COSMOS_VENUE_MANIFEST_ROUTE_NOT_FOUND");
  const route = verifiedManifest.routes[index];
  const policyBound = createPolicyBoundCosmosReaders(input.readPolicy, now, input.fetchImpl);
  if (policyBound.policy.policy.chainId !== route.chainId) throw new Error("COSMOS_READ_POLICY_ROUTE_CHAIN_MISMATCH");
  if (policyBound.policy.source.signerPublicKeyBase64 === verifiedManifest.source.signerPublicKeyBase64) throw new Error("COSMOS_READ_POLICY_REVIEWER_NOT_INDEPENDENT");
  const verifiedSwap = await verifyCosmosSwapBoundary({
    venue: createOsmosisExactInVenue(route),
    intent,
    readers: policyBound.readers,
    decodeSwapMessage: createOsmosisExactInDecoder(route),
    now
  });
  const completedAt = input.now ?? Date.now();
  const expiresAt = Math.min(intent.quoteExpiresAt, Date.parse(verifiedManifest.manifest.expiresAt), Date.parse(policyBound.policy.policy.expiresAt));
  if (completedAt < now || expiresAt <= completedAt) throw new Error("COSMOS_VERIFIED_SWAP_EXPIRED");
  const result: VerifiedSourceBoundOsmosisSwap = {
    ...verifiedSwap,
    verifiedAt: completedAt,
    expiresAt,
    sourceFingerprint: verifiedManifest.sourceFingerprint,
    manifestPayloadHash: verifiedManifest.payloadHash,
    routeFingerprint: verifiedManifest.routeFingerprints[index],
    readPolicySourceFingerprint: policyBound.policy.sourceFingerprint,
    readPolicyPayloadHash: policyBound.policy.payloadHash,
    executionEnabled: false,
    broadcastEnabled: false
  };
  verifiedSwaps.set(result, cryptographicFingerprint("realdex.verified-source-bound-osmosis-swap.v1", result));
  return result;
}

/** Source-bound evidence is an in-memory capability, not importable JSON. */
export function assertVerifiedSourceBoundOsmosisSwap(value: VerifiedSourceBoundOsmosisSwap): void {
  const expected = verifiedSwaps.get(value);
  if (!expected) throw new Error("COSMOS_VERIFIED_SWAP_NOT_AUTHENTIC");
  let current: string;
  try { current = cryptographicFingerprint("realdex.verified-source-bound-osmosis-swap.v1", value); }
  catch { throw new Error("COSMOS_VERIFIED_SWAP_CHANGED"); }
  if (current !== expected) throw new Error("COSMOS_VERIFIED_SWAP_CHANGED");
}

export function osmosisRouteFingerprint(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(validateOsmosisExactInRouteDescriptor(value))));
}

function validateUnsignedManifest(value: unknown): Omit<SignedOsmosisRouteManifest, "signatureBase64"> {
  const manifest = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "routes", "evidenceUrls"], "COSMOS_VENUE_MANIFEST_INVALID");
  if (manifest.schema !== "realdex.signed-osmosis-routes.v1" || typeof manifest.sourceId !== "string" || !SOURCE_ID.test(manifest.sourceId) || typeof manifest.sourceFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sourceFingerprint) || !Number.isSafeInteger(manifest.revision) || Number(manifest.revision) <= 0 || typeof manifest.issuedAt !== "string" || typeof manifest.expiresAt !== "string") throw new Error("COSMOS_VENUE_MANIFEST_IDENTITY_INVALID");
  if (!Array.isArray(manifest.routes) || manifest.routes.length < 1 || manifest.routes.length > MAX_ROUTES) throw new Error("COSMOS_VENUE_MANIFEST_SIZE_INVALID");
  return {
    schema: manifest.schema,
    sourceId: manifest.sourceId,
    sourceFingerprint: manifest.sourceFingerprint,
    revision: Number(manifest.revision),
    issuedAt: manifest.issuedAt,
    expiresAt: manifest.expiresAt,
    routes: manifest.routes.map(validateOsmosisExactInRouteDescriptor),
    evidenceUrls: validEvidenceUrls(manifest.evidenceUrls, 1, 32, "COSMOS_VENUE_MANIFEST_EVIDENCE_INVALID")
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

function isHttps(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }
function isCompressedPublicKey(value: unknown): value is string { try { const bytes = typeof value === "string" ? base64.decode(value) : new Uint8Array(); return bytes.length === 33 && (bytes[0] === 2 || bytes[0] === 3); } catch { return false; } }
function isCompactSignature(value: unknown): value is string { try { return typeof value === "string" && base64.decode(value).length === 64; } catch { return false; } }
function parseCanonicalTimestamp(value: string, code: string): number { const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code); return parsed; }
function sha256Hex(bytes: Uint8Array): string { return [...sha256(bytes)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function bytesToBigInt(value: Uint8Array): bigint { return BigInt(`0x${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`); }
