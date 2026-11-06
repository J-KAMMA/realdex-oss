import { Secp256k1, Secp256k1Signature, sha256 } from "@cosmjs/crypto";
import { base64 } from "@scure/base";
import { normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";
import { COSMOS_SWAP_RECOVERY_ID } from "./cosmos-swap-recovery";
import {
  COSMOS_SWAP_BOUNDARY_ID,
  createCosmosSwapReaderQuorum,
  type CosmosSwapReader
} from "./cosmos-swap-boundary";

const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const COSMOS_CHAIN = /^cosmos:[-_a-zA-Z0-9]{1,32}$/;
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const SECP256K1_HALF_ORDER = BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");

export const COSMOS_READ_POLICY_GATE_ID = "cosmos-signed-read-policy-v1";

export type CosmosReadPolicySourceDescriptor = {
  schema: "realdex.cosmos-read-policy-source.v1";
  id: string;
  name: string;
  signerPublicKeyBase64: string;
  allowedChainIds: string[];
  evidenceUrls: string[];
};

export type SignedCosmosReadPolicy = {
  schema: "realdex.signed-cosmos-read-policy.v1";
  sourceId: string;
  sourceFingerprint: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  chainId: string;
  restEndpoints: [string, string];
  simulationBoundaryId: typeof COSMOS_SWAP_BOUNDARY_ID;
  /** Explicit signed opt-in. Legacy simulation-only policies cannot query recovery. */
  recoveryBoundaryId?: typeof COSMOS_SWAP_RECOVERY_ID;
  evidenceUrls: string[];
  signatureBase64: string;
};

export type CosmosReadPolicyHead = { revision: number; payloadHash: string };

export type VerifiedCosmosReadPolicy = {
  schema: "realdex.verified-cosmos-read-policy.v1";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  broadcastEnabled: false;
  source: CosmosReadPolicySourceDescriptor;
  sourceFingerprint: string;
  policy: SignedCosmosReadPolicy;
  payloadHash: string;
  verifiedAt: number;
};

export type PolicyBoundCosmosReaders = {
  policy: VerifiedCosmosReadPolicy;
  readers: CosmosSwapReader[];
};

export function validateCosmosReadPolicySource(value: unknown): CosmosReadPolicySourceDescriptor {
  const source = strictObject(value, ["schema", "id", "name", "signerPublicKeyBase64", "allowedChainIds", "evidenceUrls"], "COSMOS_READ_POLICY_SOURCE_INVALID");
  if (source.schema !== "realdex.cosmos-read-policy-source.v1" || typeof source.id !== "string" || !SOURCE_ID.test(source.id) || typeof source.name !== "string" || !source.name.trim() || source.name.length > 100 || !isCompressedPublicKey(source.signerPublicKeyBase64)) throw new Error("COSMOS_READ_POLICY_SOURCE_IDENTITY_INVALID");
  if (!Array.isArray(source.allowedChainIds) || source.allowedChainIds.length < 1 || source.allowedChainIds.length > 16 || source.allowedChainIds.some((chainId) => typeof chainId !== "string" || !COSMOS_CHAIN.test(chainId)) || new Set(source.allowedChainIds).size !== source.allowedChainIds.length) throw new Error("COSMOS_READ_POLICY_SOURCE_CHAINS_INVALID");
  return {
    schema: source.schema,
    id: source.id,
    name: source.name,
    signerPublicKeyBase64: source.signerPublicKeyBase64 as string,
    allowedChainIds: [...source.allowedChainIds] as string[],
    evidenceUrls: validEvidenceUrls(source.evidenceUrls, "COSMOS_READ_POLICY_SOURCE_EVIDENCE_INVALID")
  };
}

export function cosmosReadPolicySourceFingerprint(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(validateCosmosReadPolicySource(value))));
}

export function canonicalSignedCosmosReadPolicyPayload(value: Omit<SignedCosmosReadPolicy, "signatureBase64">): string {
  return `RealDEX signed Cosmos read policy v1\n${JSON.stringify(validateUnsignedPolicy(value))}`;
}

export function verifySignedCosmosReadPolicy(
  value: unknown,
  sourceValue: unknown,
  options: { now?: number; previousHead?: CosmosReadPolicyHead } = {}
): VerifiedCosmosReadPolicy {
  const source = validateCosmosReadPolicySource(sourceValue);
  const hasRecovery = !!value && typeof value === "object" && Object.hasOwn(value, "recoveryBoundaryId");
  const root = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "chainId", "restEndpoints", "simulationBoundaryId", "evidenceUrls", "signatureBase64", ...(hasRecovery ? ["recoveryBoundaryId"] : [])], "COSMOS_READ_POLICY_INVALID");
  if (!isCompactSignature(root.signatureBase64)) throw new Error("COSMOS_READ_POLICY_SIGNATURE_INVALID");
  const { signatureBase64, ...unsignedValue } = root;
  const unsigned = validateUnsignedPolicy(unsignedValue);
  const sourceFingerprint = cosmosReadPolicySourceFingerprint(source);
  if (unsigned.sourceId !== source.id || unsigned.sourceFingerprint !== sourceFingerprint) throw new Error("COSMOS_READ_POLICY_SOURCE_MISMATCH");
  if (!source.allowedChainIds.includes(unsigned.chainId)) throw new Error("COSMOS_READ_POLICY_CHAIN_NOT_ALLOWED");
  const now = options.now ?? Date.now();
  const issuedAt = parseCanonicalTimestamp(unsigned.issuedAt, "COSMOS_READ_POLICY_ISSUED_AT_INVALID");
  const expiresAt = parseCanonicalTimestamp(unsigned.expiresAt, "COSMOS_READ_POLICY_EXPIRES_AT_INVALID");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("COSMOS_READ_POLICY_FROM_FUTURE");
  if (expiresAt <= now) throw new Error("COSMOS_READ_POLICY_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) throw new Error("COSMOS_READ_POLICY_VALIDITY_INVALID");
  const payloadBytes = new TextEncoder().encode(canonicalSignedCosmosReadPolicyPayload(unsigned));
  const payloadHash = sha256Hex(payloadBytes);
  const signature = Secp256k1Signature.fromFixedLength(base64.decode(signatureBase64 as string));
  if (bytesToBigInt(signature.s()) > SECP256K1_HALF_ORDER) throw new Error("COSMOS_READ_POLICY_HIGH_S_SIGNATURE");
  let valid = false;
  try { valid = Secp256k1.verifySignature(signature, sha256(payloadBytes), base64.decode(source.signerPublicKeyBase64)); }
  catch { throw new Error("COSMOS_READ_POLICY_SIGNATURE_INVALID"); }
  if (!valid) throw new Error("COSMOS_READ_POLICY_SIGNER_NOT_PINNED");
  if (options.previousHead) {
    const head = options.previousHead;
    if (!Number.isSafeInteger(head.revision) || head.revision <= 0 || !/^[0-9a-f]{64}$/.test(head.payloadHash)) throw new Error("COSMOS_READ_POLICY_HEAD_INVALID");
    if (unsigned.revision < head.revision) throw new Error("COSMOS_READ_POLICY_ROLLBACK_BLOCKED");
    if (unsigned.revision === head.revision && payloadHash !== head.payloadHash) throw new Error("COSMOS_READ_POLICY_REVISION_CONFLICT");
  }
  return {
    schema: "realdex.verified-cosmos-read-policy.v1",
    status: "verified-design-gate",
    executionEnabled: false,
    signingEnabled: false,
    broadcastEnabled: false,
    source,
    sourceFingerprint,
    policy: { ...unsigned, signatureBase64: signatureBase64 as string },
    payloadHash,
    verifiedAt: now
  };
}

export function revalidateCosmosReadPolicy(value: VerifiedCosmosReadPolicy, now = Date.now()): VerifiedCosmosReadPolicy {
  const keys = ["schema", "status", "executionEnabled", "signingEnabled", "broadcastEnabled", "source", "sourceFingerprint", "policy", "payloadHash", "verifiedAt"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || value.schema !== "realdex.verified-cosmos-read-policy.v1" || value.status !== "verified-design-gate" || value.executionEnabled !== false || value.signingEnabled !== false || value.broadcastEnabled !== false || !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt <= 0 || value.verifiedAt > now) throw new Error("COSMOS_READ_POLICY_VERIFICATION_INVALID");
  const verified = verifySignedCosmosReadPolicy(value.policy, value.source, { now, previousHead: { revision: value.policy.revision, payloadHash: value.payloadHash } });
  if (verified.sourceFingerprint !== value.sourceFingerprint || verified.payloadHash !== value.payloadHash) throw new Error("COSMOS_READ_POLICY_VERIFICATION_INVALID");
  return verified;
}

export function createPolicyBoundCosmosReaders(value: VerifiedCosmosReadPolicy, now = Date.now(), fetchImpl: typeof fetch = fetch): PolicyBoundCosmosReaders {
  const policy = revalidateCosmosReadPolicy(value, now);
  return { policy, readers: createCosmosSwapReaderQuorum(policy.policy.restEndpoints, fetchImpl) };
}

function validateUnsignedPolicy(value: unknown): Omit<SignedCosmosReadPolicy, "signatureBase64"> {
  const hasRecovery = !!value && typeof value === "object" && Object.hasOwn(value, "recoveryBoundaryId");
  const policy = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "chainId", "restEndpoints", "simulationBoundaryId", "evidenceUrls", ...(hasRecovery ? ["recoveryBoundaryId"] : [])], "COSMOS_READ_POLICY_INVALID");
  if (policy.schema !== "realdex.signed-cosmos-read-policy.v1" || typeof policy.sourceId !== "string" || !SOURCE_ID.test(policy.sourceId) || typeof policy.sourceFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(policy.sourceFingerprint) || !Number.isSafeInteger(policy.revision) || Number(policy.revision) <= 0 || typeof policy.issuedAt !== "string" || typeof policy.expiresAt !== "string" || typeof policy.chainId !== "string" || !COSMOS_CHAIN.test(policy.chainId)) throw new Error("COSMOS_READ_POLICY_IDENTITY_INVALID");
  if (policy.simulationBoundaryId !== COSMOS_SWAP_BOUNDARY_ID) throw new Error("COSMOS_READ_POLICY_BOUNDARY_MISMATCH");
  if (hasRecovery && policy.recoveryBoundaryId !== COSMOS_SWAP_RECOVERY_ID) throw new Error("COSMOS_READ_POLICY_RECOVERY_BOUNDARY_MISMATCH");
  if (!Array.isArray(policy.restEndpoints) || policy.restEndpoints.length !== 2 || policy.restEndpoints.some((endpoint) => typeof endpoint !== "string")) throw new Error("COSMOS_READ_POLICY_ENDPOINTS_INVALID");
  return {
    schema: policy.schema,
    sourceId: policy.sourceId,
    sourceFingerprint: policy.sourceFingerprint,
    revision: policy.revision as number,
    issuedAt: policy.issuedAt,
    expiresAt: policy.expiresAt,
    chainId: policy.chainId,
    restEndpoints: normalizeDistinctEndpoints(policy.restEndpoints as string[]),
    simulationBoundaryId: policy.simulationBoundaryId,
    ...(hasRecovery ? { recoveryBoundaryId: COSMOS_SWAP_RECOVERY_ID } : {}),
    evidenceUrls: validEvidenceUrls(policy.evidenceUrls, "COSMOS_READ_POLICY_EVIDENCE_INVALID")
  };
}

function normalizeDistinctEndpoints(values: string[]): [string, string] {
  let endpoints: string[];
  try { endpoints = values.map(normalizePublicRpcEndpoint); }
  catch { throw new Error("COSMOS_READ_POLICY_ENDPOINTS_NOT_PUBLIC"); }
  const hosts = endpoints.map((value) => new URL(value).hostname.toLowerCase());
  if (new Set(endpoints).size !== 2 || new Set(hosts).size !== 2) throw new Error("COSMOS_READ_POLICY_ENDPOINTS_NOT_INDEPENDENT");
  return endpoints as [string, string];
}

function strictObject(value: unknown, keys: readonly string[], error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(error);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) throw new Error(error);
  return object;
}

function validEvidenceUrls(value: unknown, error: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || new Set(value).size !== value.length || value.some((entry) => {
    if (typeof entry !== "string") return true;
    try { const url = new URL(entry); return url.protocol !== "https:" || Boolean(url.username || url.password) || entry.length > 2_048; } catch { return true; }
  })) throw new Error(error);
  return [...value] as string[];
}

function isCompressedPublicKey(value: unknown): value is string { try { const bytes = typeof value === "string" ? base64.decode(value) : new Uint8Array(); return bytes.length === 33 && (bytes[0] === 2 || bytes[0] === 3); } catch { return false; } }
function isCompactSignature(value: unknown): value is string { try { return typeof value === "string" && base64.decode(value).length === 64; } catch { return false; } }
function parseCanonicalTimestamp(value: string, error: string): number { const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(error); return parsed; }
function sha256Hex(bytes: Uint8Array): string { return [...sha256(bytes)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function bytesToBigInt(value: Uint8Array): bigint { return BigInt(`0x${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`); }
