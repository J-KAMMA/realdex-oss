import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";
import { SOLANA_SWAP_BOUNDARY_ID, createSolanaSwapReaderQuorum, type SolanaSwapReader } from "./solana-swap-boundary";
import { SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID, createSplTokenSwapQuoteReaderQuorum, type SplTokenSwapQuoteReader } from "./spl-token-swap-quote-boundary";

const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const SOLANA_CHAIN = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/;
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const SOLANA_READ_POLICY_GATE_ID = "solana-signed-read-policy-v1";

export type SolanaReadPolicySourceDescriptor = {
  schema: "realdex.solana-read-policy-source.v1";
  id: string;
  name: string;
  signerPublicKey: string;
  allowedChainIds: string[];
  evidenceUrls: string[];
};

export type SignedSolanaReadPolicy = {
  schema: "realdex.signed-solana-read-policy.v1";
  sourceId: string;
  sourceFingerprint: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  chainId: string;
  rpcEndpoints: [string, string];
  quoteBoundaryId: typeof SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID;
  simulationBoundaryId: typeof SOLANA_SWAP_BOUNDARY_ID;
  evidenceUrls: string[];
  signature: string;
};

export type SolanaReadPolicyHead = { revision: number; payloadHash: string };

export type VerifiedSolanaReadPolicy = {
  schema: "realdex.verified-solana-read-policy.v1";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  submissionEnabled: false;
  source: SolanaReadPolicySourceDescriptor;
  sourceFingerprint: string;
  policy: SignedSolanaReadPolicy;
  payloadHash: string;
  verifiedAt: number;
};

export type PolicyBoundSolanaReaders = {
  policy: VerifiedSolanaReadPolicy;
  swapReaders: SolanaSwapReader[];
  quoteReaders: SplTokenSwapQuoteReader[];
};

export function validateSolanaReadPolicySource(value: unknown): SolanaReadPolicySourceDescriptor {
  const source = strictObject(value, ["schema", "id", "name", "signerPublicKey", "allowedChainIds", "evidenceUrls"], "SOLANA_READ_POLICY_SOURCE_INVALID");
  if (source.schema !== "realdex.solana-read-policy-source.v1" || typeof source.id !== "string" || !SOURCE_ID.test(source.id) || typeof source.name !== "string" || !source.name.trim() || source.name.length > 100 || !isPublicKey(source.signerPublicKey)) throw new Error("SOLANA_READ_POLICY_SOURCE_IDENTITY_INVALID");
  if (!Array.isArray(source.allowedChainIds) || source.allowedChainIds.length < 1 || source.allowedChainIds.length > 16 || source.allowedChainIds.some((chainId) => typeof chainId !== "string" || !SOLANA_CHAIN.test(chainId)) || new Set(source.allowedChainIds).size !== source.allowedChainIds.length) throw new Error("SOLANA_READ_POLICY_SOURCE_CHAINS_INVALID");
  return {
    schema: source.schema, id: source.id, name: source.name, signerPublicKey: source.signerPublicKey as string,
    allowedChainIds: [...source.allowedChainIds] as string[], evidenceUrls: validEvidenceUrls(source.evidenceUrls, "SOLANA_READ_POLICY_SOURCE_EVIDENCE_INVALID")
  };
}

export async function solanaReadPolicySourceFingerprint(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(validateSolanaReadPolicySource(value))));
}

export function canonicalSignedSolanaReadPolicyPayload(value: Omit<SignedSolanaReadPolicy, "signature">): string {
  return `RealDEX signed Solana read policy v1\n${JSON.stringify(validateUnsignedPolicy(value))}`;
}

export async function verifySignedSolanaReadPolicy(
  value: unknown,
  sourceValue: unknown,
  options: { now?: number; previousHead?: SolanaReadPolicyHead } = {}
): Promise<VerifiedSolanaReadPolicy> {
  const source = validateSolanaReadPolicySource(sourceValue);
  const root = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "chainId", "rpcEndpoints", "quoteBoundaryId", "simulationBoundaryId", "evidenceUrls", "signature"], "SOLANA_READ_POLICY_INVALID");
  if (!isSignature(root.signature)) throw new Error("SOLANA_READ_POLICY_SIGNATURE_INVALID");
  const { signature, ...unsignedValue } = root;
  const unsigned = validateUnsignedPolicy(unsignedValue);
  const sourceFingerprint = await solanaReadPolicySourceFingerprint(source);
  if (unsigned.sourceId !== source.id || unsigned.sourceFingerprint !== sourceFingerprint) throw new Error("SOLANA_READ_POLICY_SOURCE_MISMATCH");
  if (!source.allowedChainIds.includes(unsigned.chainId)) throw new Error("SOLANA_READ_POLICY_CHAIN_NOT_ALLOWED");
  const now = options.now ?? Date.now();
  const issuedAt = parseCanonicalTimestamp(unsigned.issuedAt, "SOLANA_READ_POLICY_ISSUED_AT_INVALID");
  const expiresAt = parseCanonicalTimestamp(unsigned.expiresAt, "SOLANA_READ_POLICY_EXPIRES_AT_INVALID");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("SOLANA_READ_POLICY_FROM_FUTURE");
  if (expiresAt <= now) throw new Error("SOLANA_READ_POLICY_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) throw new Error("SOLANA_READ_POLICY_VALIDITY_INVALID");
  const payloadBytes = new TextEncoder().encode(canonicalSignedSolanaReadPolicyPayload(unsigned));
  const payloadHash = await sha256Hex(payloadBytes);
  let valid = false;
  try { valid = ed25519.verify(base58.decode(signature as string), payloadBytes, base58.decode(source.signerPublicKey)); }
  catch { throw new Error("SOLANA_READ_POLICY_SIGNATURE_INVALID"); }
  if (!valid) throw new Error("SOLANA_READ_POLICY_SIGNER_NOT_PINNED");
  if (options.previousHead) {
    const head = options.previousHead;
    if (!Number.isSafeInteger(head.revision) || head.revision <= 0 || !/^[0-9a-f]{64}$/.test(head.payloadHash)) throw new Error("SOLANA_READ_POLICY_HEAD_INVALID");
    if (unsigned.revision < head.revision) throw new Error("SOLANA_READ_POLICY_ROLLBACK_BLOCKED");
    if (unsigned.revision === head.revision && payloadHash !== head.payloadHash) throw new Error("SOLANA_READ_POLICY_REVISION_CONFLICT");
  }
  return {
    schema: "realdex.verified-solana-read-policy.v1", status: "verified-design-gate", executionEnabled: false, signingEnabled: false, submissionEnabled: false,
    source, sourceFingerprint, policy: { ...unsigned, signature: signature as string }, payloadHash, verifiedAt: now
  };
}

export async function revalidateSolanaReadPolicy(value: VerifiedSolanaReadPolicy, now = Date.now()): Promise<VerifiedSolanaReadPolicy> {
  const keys = ["schema", "status", "executionEnabled", "signingEnabled", "submissionEnabled", "source", "sourceFingerprint", "policy", "payloadHash", "verifiedAt"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || value.schema !== "realdex.verified-solana-read-policy.v1" || value.status !== "verified-design-gate" || value.executionEnabled !== false || value.signingEnabled !== false || value.submissionEnabled !== false || !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt <= 0 || value.verifiedAt > now) throw new Error("SOLANA_READ_POLICY_VERIFICATION_INVALID");
  const verified = await verifySignedSolanaReadPolicy(value.policy, value.source, { now, previousHead: { revision: value.policy.revision, payloadHash: value.payloadHash } });
  if (verified.sourceFingerprint !== value.sourceFingerprint || verified.payloadHash !== value.payloadHash) throw new Error("SOLANA_READ_POLICY_VERIFICATION_INVALID");
  return verified;
}

export async function createPolicyBoundSolanaReaders(value: VerifiedSolanaReadPolicy, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<PolicyBoundSolanaReaders> {
  const policy = await revalidateSolanaReadPolicy(value, now);
  return {
    policy,
    swapReaders: createSolanaSwapReaderQuorum(policy.policy.rpcEndpoints, fetchImpl),
    quoteReaders: createSplTokenSwapQuoteReaderQuorum(policy.policy.rpcEndpoints, fetchImpl)
  };
}

function validateUnsignedPolicy(value: unknown): Omit<SignedSolanaReadPolicy, "signature"> {
  const policy = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "chainId", "rpcEndpoints", "quoteBoundaryId", "simulationBoundaryId", "evidenceUrls"], "SOLANA_READ_POLICY_INVALID");
  if (policy.schema !== "realdex.signed-solana-read-policy.v1" || typeof policy.sourceId !== "string" || !SOURCE_ID.test(policy.sourceId) || typeof policy.sourceFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(policy.sourceFingerprint) || !Number.isSafeInteger(policy.revision) || Number(policy.revision) <= 0 || typeof policy.issuedAt !== "string" || typeof policy.expiresAt !== "string" || typeof policy.chainId !== "string" || !SOLANA_CHAIN.test(policy.chainId)) throw new Error("SOLANA_READ_POLICY_IDENTITY_INVALID");
  if (policy.quoteBoundaryId !== SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID || policy.simulationBoundaryId !== SOLANA_SWAP_BOUNDARY_ID) throw new Error("SOLANA_READ_POLICY_BOUNDARY_MISMATCH");
  if (!Array.isArray(policy.rpcEndpoints) || policy.rpcEndpoints.length !== 2 || policy.rpcEndpoints.some((endpoint) => typeof endpoint !== "string")) throw new Error("SOLANA_READ_POLICY_ENDPOINTS_INVALID");
  const rpcEndpoints = normalizeDistinctEndpoints(policy.rpcEndpoints as string[]);
  return {
    schema: policy.schema, sourceId: policy.sourceId, sourceFingerprint: policy.sourceFingerprint, revision: policy.revision as number,
    issuedAt: policy.issuedAt, expiresAt: policy.expiresAt, chainId: policy.chainId,
    rpcEndpoints, quoteBoundaryId: policy.quoteBoundaryId, simulationBoundaryId: policy.simulationBoundaryId,
    evidenceUrls: validEvidenceUrls(policy.evidenceUrls, "SOLANA_READ_POLICY_EVIDENCE_INVALID")
  };
}

function normalizeDistinctEndpoints(values: string[]): [string, string] {
  let endpoints: string[];
  try { endpoints = values.map(normalizePublicRpcEndpoint); }
  catch { throw new Error("SOLANA_READ_POLICY_ENDPOINTS_NOT_PUBLIC"); }
  const hosts = endpoints.map((value) => new URL(value).hostname.toLowerCase());
  if (new Set(endpoints).size !== 2 || new Set(hosts).size !== 2) throw new Error("SOLANA_READ_POLICY_ENDPOINTS_NOT_INDEPENDENT");
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

function isPublicKey(value: unknown): value is string { try { return typeof value === "string" && base58.decode(value).length === 32; } catch { return false; } }
function isSignature(value: unknown): value is string { try { return typeof value === "string" && base58.decode(value).length === 64; } catch { return false; } }
function parseCanonicalTimestamp(value: string, error: string): number { const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(error); return parsed; }
async function sha256Hex(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer); return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join(""); }
