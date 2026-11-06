import { getAddress, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { validateBitcoinFeeSafetyPolicy, type BitcoinFeeSafetyPolicy } from "./bitcoin-fee-policy";
import { assertDistinctPublicEsploraEndpoints, validateBitcoinUtxoQuorumPolicy, type BitcoinUtxoQuorumPolicy } from "./bitcoin-utxo-quorum";

const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const BIP122 = /^bip122:[0-9a-f]{32}$/;
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type BitcoinReadPolicySourceDescriptor = {
  schema: "realdex.bitcoin-read-policy-source.v1";
  id: string;
  name: string;
  signerAddress: string;
  allowedChainIds: string[];
  evidenceUrls: string[];
};

export type SignedBitcoinReadPolicy = {
  schema: "realdex.signed-bitcoin-read-policy.v1";
  sourceId: string;
  sourceFingerprint: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  chainId: string;
  esploraEndpoints: [string, string];
  utxoPolicy: BitcoinUtxoQuorumPolicy;
  feePolicy: BitcoinFeeSafetyPolicy;
  evidenceUrls: string[];
  signature: string;
};

export type BitcoinReadPolicyHead = { revision: number; payloadHash: string };

export type VerifiedBitcoinReadPolicy = {
  schema: "realdex.verified-bitcoin-read-policy.v1";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  broadcastEnabled: false;
  source: BitcoinReadPolicySourceDescriptor;
  sourceFingerprint: string;
  policy: SignedBitcoinReadPolicy;
  payloadHash: string;
  recoveredSigner: string;
  verifiedAt: number;
};

export function validateBitcoinReadPolicySource(value: unknown): BitcoinReadPolicySourceDescriptor {
  const source = strictObject(value, ["schema", "id", "name", "signerAddress", "allowedChainIds", "evidenceUrls"], "BITCOIN_READ_POLICY_SOURCE_INVALID");
  if (source.schema !== "realdex.bitcoin-read-policy-source.v1" || typeof source.id !== "string" || !SOURCE_ID.test(source.id) || typeof source.name !== "string" || !source.name.trim() || source.name.length > 100) throw new Error("BITCOIN_READ_POLICY_SOURCE_IDENTITY_INVALID");
  let signerAddress: string;
  try { signerAddress = getAddress(String(source.signerAddress)); } catch { throw new Error("BITCOIN_READ_POLICY_SOURCE_SIGNER_INVALID"); }
  if (signerAddress === "0x0000000000000000000000000000000000000000") throw new Error("BITCOIN_READ_POLICY_SOURCE_SIGNER_INVALID");
  if (!Array.isArray(source.allowedChainIds) || source.allowedChainIds.length < 1 || source.allowedChainIds.length > 16 || source.allowedChainIds.some((chainId) => typeof chainId !== "string" || !BIP122.test(chainId)) || new Set(source.allowedChainIds).size !== source.allowedChainIds.length) throw new Error("BITCOIN_READ_POLICY_SOURCE_CHAINS_INVALID");
  return { schema: source.schema, id: source.id, name: source.name, signerAddress, allowedChainIds: [...source.allowedChainIds] as string[], evidenceUrls: validEvidenceUrls(source.evidenceUrls, "BITCOIN_READ_POLICY_SOURCE_EVIDENCE_INVALID") };
}

export function bitcoinReadPolicySourceFingerprint(value: unknown): string {
  return keccak256(toUtf8Bytes(JSON.stringify(validateBitcoinReadPolicySource(value))));
}

export function canonicalSignedBitcoinReadPolicyPayload(value: Omit<SignedBitcoinReadPolicy, "signature">): string {
  return `RealDEX signed Bitcoin read policy v1\n${JSON.stringify(validateUnsignedPolicy(value))}`;
}

export function verifySignedBitcoinReadPolicy(value: unknown, sourceValue: unknown, options: { now?: number; previousHead?: BitcoinReadPolicyHead } = {}): VerifiedBitcoinReadPolicy {
  const source = validateBitcoinReadPolicySource(sourceValue);
  const root = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "chainId", "esploraEndpoints", "utxoPolicy", "feePolicy", "evidenceUrls", "signature"], "BITCOIN_READ_POLICY_INVALID");
  if (typeof root.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(root.signature)) throw new Error("BITCOIN_READ_POLICY_SIGNATURE_INVALID");
  const { signature, ...unsignedValue } = root;
  const unsigned = validateUnsignedPolicy(unsignedValue);
  const sourceFingerprint = bitcoinReadPolicySourceFingerprint(source);
  if (unsigned.sourceId !== source.id || unsigned.sourceFingerprint !== sourceFingerprint) throw new Error("BITCOIN_READ_POLICY_SOURCE_MISMATCH");
  if (!source.allowedChainIds.includes(unsigned.chainId)) throw new Error("BITCOIN_READ_POLICY_CHAIN_NOT_ALLOWED");
  const now = options.now ?? Date.now();
  const issuedAt = parseTimestamp(unsigned.issuedAt, "BITCOIN_READ_POLICY_ISSUED_AT_INVALID");
  const expiresAt = parseTimestamp(unsigned.expiresAt, "BITCOIN_READ_POLICY_EXPIRES_AT_INVALID");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("BITCOIN_READ_POLICY_FROM_FUTURE");
  if (expiresAt <= now) throw new Error("BITCOIN_READ_POLICY_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) throw new Error("BITCOIN_READ_POLICY_VALIDITY_INVALID");
  const payload = canonicalSignedBitcoinReadPolicyPayload(unsigned);
  const payloadHash = keccak256(toUtf8Bytes(payload));
  let recoveredSigner: string;
  try { recoveredSigner = getAddress(verifyMessage(payload, root.signature)); } catch { throw new Error("BITCOIN_READ_POLICY_SIGNATURE_INVALID"); }
  if (recoveredSigner !== source.signerAddress) throw new Error("BITCOIN_READ_POLICY_SIGNER_NOT_PINNED");
  if (options.previousHead) {
    const head = options.previousHead;
    if (!Number.isSafeInteger(head.revision) || head.revision <= 0 || !/^0x[0-9a-f]{64}$/.test(head.payloadHash)) throw new Error("BITCOIN_READ_POLICY_HEAD_INVALID");
    if (unsigned.revision < head.revision) throw new Error("BITCOIN_READ_POLICY_ROLLBACK_BLOCKED");
    if (unsigned.revision === head.revision && payloadHash !== head.payloadHash) throw new Error("BITCOIN_READ_POLICY_REVISION_CONFLICT");
  }
  return {
    schema: "realdex.verified-bitcoin-read-policy.v1", status: "verified-design-gate", executionEnabled: false, signingEnabled: false, broadcastEnabled: false,
    source, sourceFingerprint, policy: { ...unsigned, signature: root.signature }, payloadHash, recoveredSigner, verifiedAt: now
  };
}

export function revalidateBitcoinReadPolicy(value: VerifiedBitcoinReadPolicy, now = Date.now()): VerifiedBitcoinReadPolicy {
  if (!value || value.schema !== "realdex.verified-bitcoin-read-policy.v1" || value.status !== "verified-design-gate" || value.executionEnabled !== false || value.signingEnabled !== false || value.broadcastEnabled !== false) throw new Error("BITCOIN_READ_POLICY_VERIFICATION_INVALID");
  const verified = verifySignedBitcoinReadPolicy(value.policy, value.source, { now, previousHead: { revision: value.policy.revision, payloadHash: value.payloadHash } });
  if (verified.sourceFingerprint !== value.sourceFingerprint || verified.payloadHash !== value.payloadHash || verified.recoveredSigner !== value.recoveredSigner || value.verifiedAt > now) throw new Error("BITCOIN_READ_POLICY_VERIFICATION_INVALID");
  return verified;
}

function validateUnsignedPolicy(value: unknown): Omit<SignedBitcoinReadPolicy, "signature"> {
  const policy = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "chainId", "esploraEndpoints", "utxoPolicy", "feePolicy", "evidenceUrls"], "BITCOIN_READ_POLICY_INVALID");
  if (policy.schema !== "realdex.signed-bitcoin-read-policy.v1" || typeof policy.sourceId !== "string" || !SOURCE_ID.test(policy.sourceId) || typeof policy.sourceFingerprint !== "string" || !/^0x[0-9a-f]{64}$/.test(policy.sourceFingerprint) || !Number.isSafeInteger(policy.revision) || Number(policy.revision) <= 0 || typeof policy.issuedAt !== "string" || typeof policy.expiresAt !== "string" || typeof policy.chainId !== "string" || !BIP122.test(policy.chainId)) throw new Error("BITCOIN_READ_POLICY_IDENTITY_INVALID");
  if (!Array.isArray(policy.esploraEndpoints) || policy.esploraEndpoints.length !== 2 || policy.esploraEndpoints.some((endpoint) => typeof endpoint !== "string")) throw new Error("BITCOIN_READ_POLICY_ENDPOINTS_INVALID");
  const esploraEndpoints = assertDistinctPublicEsploraEndpoints(policy.esploraEndpoints as string[]) as [string, string];
  const utxoPolicy = strictObject(policy.utxoPolicy, ["minConfirmations", "maxTipDivergence"], "BITCOIN_READ_POLICY_UTXO_INVALID") as BitcoinUtxoQuorumPolicy;
  try { validateBitcoinUtxoQuorumPolicy(utxoPolicy); } catch { throw new Error("BITCOIN_READ_POLICY_UTXO_INVALID"); }
  const feePolicy = strictObject(policy.feePolicy, ["confirmationTargetBlocks", "minFeeRateMilliSatsPerVbyte", "maxFeeRateMilliSatsPerVbyte", "minRecommendationRatioBps", "maxRecommendationRatioBps", "maxReaderDivergenceBps"], "BITCOIN_READ_POLICY_FEE_INVALID") as BitcoinFeeSafetyPolicy;
  try { validateBitcoinFeeSafetyPolicy(feePolicy); } catch { throw new Error("BITCOIN_READ_POLICY_FEE_INVALID"); }
  return {
    schema: policy.schema, sourceId: policy.sourceId, sourceFingerprint: policy.sourceFingerprint, revision: policy.revision as number,
    issuedAt: policy.issuedAt, expiresAt: policy.expiresAt, chainId: policy.chainId, esploraEndpoints,
    utxoPolicy: { minConfirmations: utxoPolicy.minConfirmations, maxTipDivergence: utxoPolicy.maxTipDivergence },
    feePolicy: {
      confirmationTargetBlocks: feePolicy.confirmationTargetBlocks, minFeeRateMilliSatsPerVbyte: feePolicy.minFeeRateMilliSatsPerVbyte,
      maxFeeRateMilliSatsPerVbyte: feePolicy.maxFeeRateMilliSatsPerVbyte, minRecommendationRatioBps: feePolicy.minRecommendationRatioBps,
      maxRecommendationRatioBps: feePolicy.maxRecommendationRatioBps, maxReaderDivergenceBps: feePolicy.maxReaderDivergenceBps
    },
    evidenceUrls: validEvidenceUrls(policy.evidenceUrls, "BITCOIN_READ_POLICY_EVIDENCE_INVALID")
  };
}

function strictObject(value: unknown, keys: string[], error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  const actual = Object.keys(value as Record<string, unknown>).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(error);
  return value as Record<string, unknown>;
}

function validEvidenceUrls(value: unknown, error: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || new Set(value).size !== value.length || value.some((entry) => {
    if (typeof entry !== "string") return true;
    try { const url = new URL(entry); return url.protocol !== "https:" || Boolean(url.username || url.password); } catch { return true; }
  })) throw new Error(error);
  return [...value] as string[];
}

function parseTimestamp(value: string, error: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(error);
  return parsed;
}
