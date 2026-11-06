import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import {
  validateSolanaVenueDescriptor,
  verifySolanaSwapBoundary,
  type SolanaSwapInstructionDecoder,
  type SolanaSwapIntent,
  type SolanaSwapReader,
  type SolanaVenueDescriptor,
  type VerifiedSolanaSwap
} from "./solana-swap-boundary";

const MAX_VENUES = 64;
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const SOLANA_CHAIN = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/;

export const SOLANA_VENUE_SOURCE_GATE_ID = "solana-signed-venue-source-v1";

export type SolanaVenueSourceDescriptor = {
  schema: "realdex.solana-venue-source.v1";
  id: string;
  name: string;
  signerPublicKey: string;
  allowedChainIds: string[];
  evidenceUrls: string[];
};

export type SignedSolanaVenueManifest = {
  schema: "realdex.signed-solana-venues.v1";
  sourceId: string;
  sourceFingerprint: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  venues: SolanaVenueDescriptor[];
  evidenceUrls: string[];
  signature: string;
};

export type SolanaVenueSourceHead = { revision: number; payloadHash: string };

export type VerifiedSolanaVenueManifest = {
  status: "verified-design-gate";
  executionEnabled: false;
  source: SolanaVenueSourceDescriptor;
  sourceFingerprint: string;
  manifest: SignedSolanaVenueManifest;
  venues: SolanaVenueDescriptor[];
  venueFingerprints: string[];
  payloadHash: string;
};

export type VerifiedSourceBoundSolanaSwap = VerifiedSolanaSwap & {
  sourceFingerprint: string;
  manifestPayloadHash: string;
  venueFingerprint: string;
  executionEnabled: false;
};

export function validateSolanaVenueSource(value: unknown): SolanaVenueSourceDescriptor {
  const source = strictObject(value, ["schema", "id", "name", "signerPublicKey", "allowedChainIds", "evidenceUrls"], "SOLANA_VENUE_SOURCE_INVALID");
  if (source.schema !== "realdex.solana-venue-source.v1" || typeof source.id !== "string" || !SOURCE_ID.test(source.id) || typeof source.name !== "string" || !source.name.trim() || source.name.length > 100 || !isPublicKey(source.signerPublicKey)) throw new Error("SOLANA_VENUE_SOURCE_IDENTITY_INVALID");
  if (!Array.isArray(source.allowedChainIds) || source.allowedChainIds.length < 1 || source.allowedChainIds.length > 100 || source.allowedChainIds.some((chain) => typeof chain !== "string" || !SOLANA_CHAIN.test(chain)) || new Set(source.allowedChainIds).size !== source.allowedChainIds.length) throw new Error("SOLANA_VENUE_SOURCE_CHAINS_INVALID");
  return {
    schema: source.schema,
    id: source.id,
    name: source.name,
    signerPublicKey: source.signerPublicKey as string,
    allowedChainIds: [...source.allowedChainIds] as string[],
    evidenceUrls: validEvidenceUrls(source.evidenceUrls, 1, 16, "SOLANA_VENUE_SOURCE_EVIDENCE_INVALID")
  };
}

export async function solanaVenueSourceFingerprint(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(validateSolanaVenueSource(value))));
}

export function canonicalSignedSolanaVenueManifestPayload(value: Omit<SignedSolanaVenueManifest, "signature">): string {
  return `RealDEX signed Solana venue manifest v1\n${JSON.stringify(validateUnsignedManifest(value))}`;
}

export async function verifySignedSolanaVenueManifest(
  value: unknown,
  sourceValue: unknown,
  options: { now?: number; previousHead?: SolanaVenueSourceHead } = {}
): Promise<VerifiedSolanaVenueManifest> {
  const source = validateSolanaVenueSource(sourceValue);
  const root = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "venues", "evidenceUrls", "signature"], "SOLANA_VENUE_MANIFEST_INVALID");
  if (!isSignature(root.signature)) throw new Error("SOLANA_VENUE_MANIFEST_SIGNATURE_INVALID");
  const { signature, ...unsignedValue } = root;
  const unsigned = validateUnsignedManifest(unsignedValue);
  const sourceFingerprint = await solanaVenueSourceFingerprint(source);
  if (unsigned.sourceId !== source.id || unsigned.sourceFingerprint !== sourceFingerprint) throw new Error("SOLANA_VENUE_MANIFEST_SOURCE_MISMATCH");

  const now = options.now ?? Date.now();
  const issuedAt = parseCanonicalTimestamp(unsigned.issuedAt, "SOLANA_VENUE_MANIFEST_ISSUED_AT_INVALID");
  const expiresAt = parseCanonicalTimestamp(unsigned.expiresAt, "SOLANA_VENUE_MANIFEST_EXPIRES_AT_INVALID");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("SOLANA_VENUE_MANIFEST_FROM_FUTURE");
  if (expiresAt <= now) throw new Error("SOLANA_VENUE_MANIFEST_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) throw new Error("SOLANA_VENUE_MANIFEST_VALIDITY_INVALID");
  if (unsigned.venues.some((venue) => !source.allowedChainIds.includes(venue.chainId))) throw new Error("SOLANA_VENUE_MANIFEST_CHAIN_NOT_ALLOWED");

  const venueFingerprints = await Promise.all(unsigned.venues.map(solanaVenueFingerprint));
  if (new Set(unsigned.venues.map((venue) => venue.venueId)).size !== unsigned.venues.length || new Set(venueFingerprints).size !== venueFingerprints.length) throw new Error("SOLANA_VENUE_MANIFEST_VENUE_DUPLICATE");

  const payload = canonicalSignedSolanaVenueManifestPayload(unsigned);
  const payloadBytes = new TextEncoder().encode(payload);
  const payloadHash = await sha256Hex(payloadBytes);
  let valid = false;
  try { valid = ed25519.verify(base58.decode(signature as string), payloadBytes, base58.decode(source.signerPublicKey)); }
  catch { throw new Error("SOLANA_VENUE_MANIFEST_SIGNATURE_INVALID"); }
  if (!valid) throw new Error("SOLANA_VENUE_MANIFEST_SIGNER_NOT_PINNED");

  if (options.previousHead) {
    const head = options.previousHead;
    if (!Number.isSafeInteger(head.revision) || head.revision <= 0 || !/^[0-9a-f]{64}$/.test(head.payloadHash)) throw new Error("SOLANA_VENUE_MANIFEST_HEAD_INVALID");
    if (unsigned.revision < head.revision) throw new Error("SOLANA_VENUE_MANIFEST_ROLLBACK_BLOCKED");
    if (unsigned.revision === head.revision && payloadHash !== head.payloadHash) throw new Error("SOLANA_VENUE_MANIFEST_REVISION_CONFLICT");
  }

  return {
    status: "verified-design-gate",
    executionEnabled: false,
    source,
    sourceFingerprint,
    manifest: { ...unsigned, signature: signature as string },
    venues: unsigned.venues,
    venueFingerprints,
    payloadHash
  };
}

export async function verifySourceBoundSolanaSwap(input: {
  source: unknown;
  signedManifest: unknown;
  previousHead?: SolanaVenueSourceHead;
  venueId: string;
  intent: SolanaSwapIntent;
  readers: readonly SolanaSwapReader[];
  decodeSwapInstruction: SolanaSwapInstructionDecoder;
  now?: number;
}): Promise<VerifiedSourceBoundSolanaSwap> {
  const verifiedManifest = await verifySignedSolanaVenueManifest(input.signedManifest, input.source, { now: input.now, previousHead: input.previousHead });
  const index = verifiedManifest.venues.findIndex((venue) => venue.venueId === input.venueId);
  if (index < 0) throw new Error("SOLANA_VENUE_MANIFEST_VENUE_NOT_FOUND");
  const verifiedSwap = await verifySolanaSwapBoundary({
    venue: verifiedManifest.venues[index],
    intent: input.intent,
    readers: input.readers,
    decodeSwapInstruction: input.decodeSwapInstruction,
    now: input.now
  });
  return {
    ...verifiedSwap,
    sourceFingerprint: verifiedManifest.sourceFingerprint,
    manifestPayloadHash: verifiedManifest.payloadHash,
    venueFingerprint: verifiedManifest.venueFingerprints[index],
    executionEnabled: false
  };
}

export async function solanaVenueFingerprint(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(validateSolanaVenueDescriptor(value))));
}

function validateUnsignedManifest(value: unknown): Omit<SignedSolanaVenueManifest, "signature"> {
  const manifest = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "venues", "evidenceUrls"], "SOLANA_VENUE_MANIFEST_INVALID");
  if (manifest.schema !== "realdex.signed-solana-venues.v1" || typeof manifest.sourceId !== "string" || !SOURCE_ID.test(manifest.sourceId) || typeof manifest.sourceFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sourceFingerprint) || !Number.isSafeInteger(manifest.revision) || Number(manifest.revision) <= 0 || typeof manifest.issuedAt !== "string" || typeof manifest.expiresAt !== "string") throw new Error("SOLANA_VENUE_MANIFEST_IDENTITY_INVALID");
  if (!Array.isArray(manifest.venues) || manifest.venues.length < 1 || manifest.venues.length > MAX_VENUES) throw new Error("SOLANA_VENUE_MANIFEST_SIZE_INVALID");
  return {
    schema: manifest.schema,
    sourceId: manifest.sourceId,
    sourceFingerprint: manifest.sourceFingerprint,
    revision: Number(manifest.revision),
    issuedAt: manifest.issuedAt,
    expiresAt: manifest.expiresAt,
    venues: manifest.venues.map(validateSolanaVenueDescriptor),
    evidenceUrls: validEvidenceUrls(manifest.evidenceUrls, 1, 32, "SOLANA_VENUE_MANIFEST_EVIDENCE_INVALID")
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
function isPublicKey(value: unknown): value is string { try { return typeof value === "string" && base58.decode(value).length === 32; } catch { return false; } }
function isSignature(value: unknown): value is string { try { return typeof value === "string" && base58.decode(value).length === 64; } catch { return false; } }
function parseCanonicalTimestamp(value: string, code: string): number { const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code); return parsed; }
async function sha256Hex(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
