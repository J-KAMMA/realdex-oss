import { getAddress, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { BASE_SEPOLIA_CCTP_ASSET, type CctpAssetReleaseEvidence } from "./cctp-asset-release";
import {
  cctpSourceBytecodeVerificationArtifactSha256,
  validateCctpSourceBytecodeVerificationArtifact,
  type CctpSourceBytecodeVerificationArtifact
} from "./cctp-source-bytecode-verification";

const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const HEX_32 = /^0x[0-9a-f]{64}$/;
const SHA_256 = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_MANIFEST_VALIDITY_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_OBSERVATION_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_HEAD_DIVERGENCE = 12;
const CIRCLE_STABLECOIN_REPOSITORY = "https://github.com/circlefin/stablecoin-evm";
const BASE_USDC_ASSET_ID = `eip155:84532/erc20:${BASE_SEPOLIA_CCTP_ASSET.address}`;

export const CCTP_ASSET_RELEASE_BOUNDARY_ID = "cctp-base-usdc-signed-release-review-v1";

export type CctpAssetReleaseSourceDescriptor = {
  schema: "realdex.cctp-asset-release-source.v1";
  id: string;
  name: string;
  signerAddress: string;
  assetId: typeof BASE_USDC_ASSET_ID;
  evidenceUrls: string[];
};

export type CctpAssetSourceReview = {
  repositoryUrl: typeof CIRCLE_STABLECOIN_REPOSITORY;
  commitSha: string;
  compilerVersion: "0.6.12+commit.27d51765";
  optimizerRuns: 10_000_000;
  verificationMode: "partial-runtime";
  sourceTreeSha256: string;
  proxySourceSha256: string;
  implementationSourceSha256: string;
  signatureCheckerAddress: string;
  signatureCheckerCodeHash: string;
  verificationArtifactSha256: string;
};

export type SignedCctpAssetReleaseManifest = {
  schema: "realdex.signed-cctp-asset-release.v1";
  sourceId: string;
  sourceFingerprint: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  assetId: typeof BASE_USDC_ASSET_ID;
  boundaryId: typeof CCTP_ASSET_RELEASE_BOUNDARY_ID;
  observationFingerprint: string;
  readerIds: [string, string];
  minimumObservedBlock: number;
  proxyCodeHash: string;
  implementationAddress: string;
  implementationCodeHash: string;
  sourceReview: CctpAssetSourceReview;
  recommendation: "approve-for-explicit-user-release";
  evidenceUrls: string[];
  signature: string;
};

export type CctpAssetReleaseHead = { revision: number; payloadHash: string };

export type VerifiedCctpAssetReleaseManifest = {
  schema: "realdex.verified-cctp-asset-release.v1";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  submissionEnabled: false;
  explicitUserReleaseRequired: true;
  source: CctpAssetReleaseSourceDescriptor;
  sourceFingerprint: string;
  manifest: SignedCctpAssetReleaseManifest;
  payloadHash: string;
  observationFingerprint: string;
  verificationArtifact: CctpSourceBytecodeVerificationArtifact;
  verificationArtifactSha256: string;
  verifiedAt: number;
};

export function validateCctpAssetReleaseSource(value: unknown): CctpAssetReleaseSourceDescriptor {
  const source = strictObject(value, ["schema", "id", "name", "signerAddress", "assetId", "evidenceUrls"], "CCTP_ASSET_RELEASE_SOURCE_INVALID");
  if (source.schema !== "realdex.cctp-asset-release-source.v1" || typeof source.id !== "string" || !SOURCE_ID.test(source.id) || typeof source.name !== "string" || !source.name.trim() || source.name.length > 100 || source.assetId !== BASE_USDC_ASSET_ID) throw new Error("CCTP_ASSET_RELEASE_SOURCE_IDENTITY_INVALID");
  return {
    schema: source.schema,
    id: source.id,
    name: source.name,
    signerAddress: normalizedAddress(source.signerAddress, "CCTP_ASSET_RELEASE_SOURCE_SIGNER_INVALID"),
    assetId: BASE_USDC_ASSET_ID,
    evidenceUrls: validEvidenceUrls(source.evidenceUrls, "CCTP_ASSET_RELEASE_SOURCE_EVIDENCE_INVALID")
  };
}

export function cctpAssetReleaseSourceFingerprint(value: unknown): string {
  return cryptographicFingerprint("cctp-asset-release-source-v1", validateCctpAssetReleaseSource(value));
}

export function cctpAssetObservationFingerprint(value: unknown, now = Date.now()): string {
  return cryptographicFingerprint("cctp-base-usdc-observation-v1", normalizedObservationEvidence(value, now));
}

export function canonicalSignedCctpAssetReleasePayload(value: Omit<SignedCctpAssetReleaseManifest, "signature">): string {
  return `RealDEX signed CCTP asset release review v1\n${JSON.stringify(validateUnsignedManifest(value))}`;
}

export function verifySignedCctpAssetReleaseManifest(
  value: unknown,
  sourceValue: unknown,
  expectedSourceFingerprint: string,
  observationValue: unknown,
  verificationArtifactValue: unknown,
  options: { now?: number; previousHead?: CctpAssetReleaseHead } = {}
): VerifiedCctpAssetReleaseManifest {
  const now = options.now ?? Date.now();
  const source = validateCctpAssetReleaseSource(sourceValue);
  const sourceFingerprint = cctpAssetReleaseSourceFingerprint(source);
  if (!HEX_32.test(expectedSourceFingerprint) || expectedSourceFingerprint !== sourceFingerprint) throw new Error("CCTP_ASSET_RELEASE_SOURCE_NOT_PINNED");
  const root = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "assetId", "boundaryId", "observationFingerprint", "readerIds", "minimumObservedBlock", "proxyCodeHash", "implementationAddress", "implementationCodeHash", "sourceReview", "recommendation", "evidenceUrls", "signature"], "CCTP_ASSET_RELEASE_MANIFEST_INVALID");
  if (typeof root.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(root.signature)) throw new Error("CCTP_ASSET_RELEASE_SIGNATURE_INVALID");
  const { signature, ...unsignedValue } = root;
  const unsigned = validateUnsignedManifest(unsignedValue);
  if (unsigned.sourceId !== source.id || unsigned.sourceFingerprint !== sourceFingerprint || unsigned.assetId !== source.assetId) throw new Error("CCTP_ASSET_RELEASE_SOURCE_MISMATCH");
  const issuedAt = parseCanonicalTimestamp(unsigned.issuedAt, "CCTP_ASSET_RELEASE_ISSUED_AT_INVALID");
  const expiresAt = parseCanonicalTimestamp(unsigned.expiresAt, "CCTP_ASSET_RELEASE_EXPIRES_AT_INVALID");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("CCTP_ASSET_RELEASE_FROM_FUTURE");
  if (expiresAt <= now) throw new Error("CCTP_ASSET_RELEASE_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_MANIFEST_VALIDITY_MS) throw new Error("CCTP_ASSET_RELEASE_VALIDITY_INVALID");
  const observation = normalizedObservationEvidence(observationValue, now);
  if (observation.observedAt > issuedAt) throw new Error("CCTP_ASSET_RELEASE_PREDATES_OBSERVATION");
  const observationFingerprint = cryptographicFingerprint("cctp-base-usdc-observation-v1", observation);
  const identity = observation.observations[0];
  if (unsigned.observationFingerprint !== observationFingerprint
    || unsigned.readerIds[0] !== observation.observations[0].readerId
    || unsigned.readerIds[1] !== observation.observations[1].readerId
    || unsigned.minimumObservedBlock !== Math.min(...observation.observations.map((item) => item.observedBlock))
    || unsigned.proxyCodeHash !== identity.proxyCodeHash
    || unsigned.implementationAddress !== identity.implementationAddress
    || unsigned.implementationCodeHash !== identity.implementationCodeHash) throw new Error("CCTP_ASSET_RELEASE_OBSERVATION_MISMATCH");
  const verificationArtifact = validateCctpSourceBytecodeVerificationArtifact(verificationArtifactValue);
  const verificationArtifactSha256 = cctpSourceBytecodeVerificationArtifactSha256(verificationArtifact);
  assertVerificationArtifactBinding(verificationArtifact, verificationArtifactSha256, unsigned, observation, issuedAt, now);
  const payload = canonicalSignedCctpAssetReleasePayload(unsigned);
  const payloadHash = keccak256(toUtf8Bytes(payload));
  let recoveredSigner: string;
  try { recoveredSigner = getAddress(verifyMessage(payload, signature as string)); }
  catch { throw new Error("CCTP_ASSET_RELEASE_SIGNATURE_INVALID"); }
  if (recoveredSigner !== source.signerAddress) throw new Error("CCTP_ASSET_RELEASE_SIGNER_NOT_PINNED");
  if (options.previousHead) assertMonotonicHead(unsigned.revision, payloadHash, options.previousHead);
  return {
    schema: "realdex.verified-cctp-asset-release.v1",
    status: "verified-design-gate",
    executionEnabled: false,
    signingEnabled: false,
    submissionEnabled: false,
    explicitUserReleaseRequired: true,
    source,
    sourceFingerprint,
    manifest: { ...unsigned, signature: signature as string },
    payloadHash,
    observationFingerprint,
    verificationArtifact,
    verificationArtifactSha256,
    verifiedAt: now
  };
}

export function revalidateVerifiedCctpAssetRelease(value: VerifiedCctpAssetReleaseManifest, observation: CctpAssetReleaseEvidence, now = Date.now()): VerifiedCctpAssetReleaseManifest {
  const keys = ["schema", "status", "executionEnabled", "signingEnabled", "submissionEnabled", "explicitUserReleaseRequired", "source", "sourceFingerprint", "manifest", "payloadHash", "observationFingerprint", "verificationArtifact", "verificationArtifactSha256", "verifiedAt"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || value.schema !== "realdex.verified-cctp-asset-release.v1" || value.status !== "verified-design-gate" || value.executionEnabled !== false || value.signingEnabled !== false || value.submissionEnabled !== false || value.explicitUserReleaseRequired !== true || !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt <= 0 || value.verifiedAt > now) throw new Error("CCTP_ASSET_RELEASE_VERIFICATION_INVALID");
  const verified = verifySignedCctpAssetReleaseManifest(value.manifest, value.source, value.sourceFingerprint, observation, value.verificationArtifact, { now, previousHead: { revision: value.manifest.revision, payloadHash: value.payloadHash } });
  if (verified.payloadHash !== value.payloadHash || verified.observationFingerprint !== value.observationFingerprint || verified.verificationArtifactSha256 !== value.verificationArtifactSha256) throw new Error("CCTP_ASSET_RELEASE_VERIFICATION_INVALID");
  return verified;
}

function assertVerificationArtifactBinding(
  artifact: CctpSourceBytecodeVerificationArtifact,
  artifactSha256: string,
  manifest: Omit<SignedCctpAssetReleaseManifest, "signature">,
  observation: ReturnType<typeof normalizedObservationEvidence>,
  issuedAt: number,
  now: number
): void {
  const review = manifest.sourceReview;
  const observedAt = Date.parse(artifact.observedAt);
  if (observedAt > issuedAt || observedAt > now + MAX_CLOCK_SKEW_MS || now - observedAt > MAX_OBSERVATION_AGE_MS) throw new Error("CCTP_ASSET_RELEASE_ARTIFACT_TIME_INVALID");
  if (artifactSha256 !== review.verificationArtifactSha256
    || artifact.repository.url !== review.repositoryUrl
    || artifact.repository.commitSha !== review.commitSha
    || artifact.compiler.version !== review.compilerVersion
    || artifact.compiler.optimizerRuns !== review.optimizerRuns
    || artifact.verificationMode !== review.verificationMode
    || artifact.sourceTreeSha256 !== review.sourceTreeSha256
    || artifact.contracts.proxy.sourceSha256 !== review.proxySourceSha256
    || artifact.contracts.implementation.sourceSha256 !== review.implementationSourceSha256
    || artifact.asset.signatureCheckerAddress !== review.signatureCheckerAddress.toLowerCase()
    || artifact.contracts.signatureChecker.observedFullRuntimeKeccak256 !== review.signatureCheckerCodeHash) throw new Error("CCTP_ASSET_RELEASE_ARTIFACT_REVIEW_MISMATCH");
  const identity = observation.observations[0];
  if (artifact.network.readerIds[0] !== manifest.readerIds[0]
    || artifact.network.readerIds[1] !== manifest.readerIds[1]
    || artifact.asset.implementationAddress !== manifest.implementationAddress.toLowerCase()
    || artifact.contracts.proxy.observedFullRuntimeKeccak256 !== manifest.proxyCodeHash
    || artifact.contracts.implementation.observedFullRuntimeKeccak256 !== manifest.implementationCodeHash
    || artifact.asset.implementationAddress !== identity.implementationAddress.toLowerCase()
    || artifact.contracts.proxy.observedFullRuntimeKeccak256 !== identity.proxyCodeHash
    || artifact.contracts.implementation.observedFullRuntimeKeccak256 !== identity.implementationCodeHash) throw new Error("CCTP_ASSET_RELEASE_ARTIFACT_OBSERVATION_MISMATCH");
}

function validateUnsignedManifest(value: unknown): Omit<SignedCctpAssetReleaseManifest, "signature"> {
  const manifest = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "assetId", "boundaryId", "observationFingerprint", "readerIds", "minimumObservedBlock", "proxyCodeHash", "implementationAddress", "implementationCodeHash", "sourceReview", "recommendation", "evidenceUrls"], "CCTP_ASSET_RELEASE_MANIFEST_INVALID");
  if (manifest.schema !== "realdex.signed-cctp-asset-release.v1" || typeof manifest.sourceId !== "string" || !SOURCE_ID.test(manifest.sourceId) || typeof manifest.sourceFingerprint !== "string" || !HEX_32.test(manifest.sourceFingerprint) || !Number.isSafeInteger(manifest.revision) || Number(manifest.revision) <= 0 || typeof manifest.issuedAt !== "string" || typeof manifest.expiresAt !== "string" || manifest.assetId !== BASE_USDC_ASSET_ID || manifest.boundaryId !== CCTP_ASSET_RELEASE_BOUNDARY_ID || typeof manifest.observationFingerprint !== "string" || !HEX_32.test(manifest.observationFingerprint) || !Number.isSafeInteger(manifest.minimumObservedBlock) || Number(manifest.minimumObservedBlock) < 0 || typeof manifest.proxyCodeHash !== "string" || !HEX_32.test(manifest.proxyCodeHash) || typeof manifest.implementationCodeHash !== "string" || !HEX_32.test(manifest.implementationCodeHash) || manifest.recommendation !== "approve-for-explicit-user-release") throw new Error("CCTP_ASSET_RELEASE_IDENTITY_INVALID");
  if (!Array.isArray(manifest.readerIds) || manifest.readerIds.length !== 2 || manifest.readerIds.some((id) => typeof id !== "string" || !validReaderId(id)) || new Set(manifest.readerIds.map((id) => String(id).toLowerCase())).size !== 2) throw new Error("CCTP_ASSET_RELEASE_READERS_INVALID");
  const sourceReview = validateSourceReview(manifest.sourceReview);
  return {
    schema: manifest.schema,
    sourceId: manifest.sourceId,
    sourceFingerprint: manifest.sourceFingerprint,
    revision: manifest.revision as number,
    issuedAt: manifest.issuedAt,
    expiresAt: manifest.expiresAt,
    assetId: BASE_USDC_ASSET_ID,
    boundaryId: CCTP_ASSET_RELEASE_BOUNDARY_ID,
    observationFingerprint: manifest.observationFingerprint,
    readerIds: [manifest.readerIds[0] as string, manifest.readerIds[1] as string],
    minimumObservedBlock: manifest.minimumObservedBlock as number,
    proxyCodeHash: manifest.proxyCodeHash,
    implementationAddress: normalizedAddress(manifest.implementationAddress, "CCTP_ASSET_RELEASE_IMPLEMENTATION_INVALID"),
    implementationCodeHash: manifest.implementationCodeHash,
    sourceReview,
    recommendation: manifest.recommendation,
    evidenceUrls: validEvidenceUrls(manifest.evidenceUrls, "CCTP_ASSET_RELEASE_EVIDENCE_INVALID")
  };
}

function validateSourceReview(value: unknown): CctpAssetSourceReview {
  const review = strictObject(value, ["repositoryUrl", "commitSha", "compilerVersion", "optimizerRuns", "verificationMode", "sourceTreeSha256", "proxySourceSha256", "implementationSourceSha256", "signatureCheckerAddress", "signatureCheckerCodeHash", "verificationArtifactSha256"], "CCTP_ASSET_RELEASE_SOURCE_REVIEW_INVALID");
  if (review.repositoryUrl !== CIRCLE_STABLECOIN_REPOSITORY
    || typeof review.commitSha !== "string" || !COMMIT_SHA.test(review.commitSha)
    || review.compilerVersion !== "0.6.12+commit.27d51765" || review.optimizerRuns !== 10_000_000
    || review.verificationMode !== "partial-runtime"
    || typeof review.sourceTreeSha256 !== "string" || !SHA_256.test(review.sourceTreeSha256)
    || typeof review.proxySourceSha256 !== "string" || !SHA_256.test(review.proxySourceSha256)
    || typeof review.implementationSourceSha256 !== "string" || !SHA_256.test(review.implementationSourceSha256)
    || typeof review.signatureCheckerCodeHash !== "string" || !HEX_32.test(review.signatureCheckerCodeHash)
    || typeof review.verificationArtifactSha256 !== "string" || !SHA_256.test(review.verificationArtifactSha256)) throw new Error("CCTP_ASSET_RELEASE_SOURCE_REVIEW_INVALID");
  return { ...review, signatureCheckerAddress: normalizedAddress(review.signatureCheckerAddress, "CCTP_ASSET_RELEASE_SOURCE_REVIEW_INVALID") } as CctpAssetSourceReview;
}

function normalizedObservationEvidence(value: unknown, now: number) {
  const evidence = strictObject(value, ["status", "asset", "observations", "observedAt", "executionEnabled", "releaseApprovalRequired"], "CCTP_ASSET_OBSERVATION_INVALID");
  if (evidence.status !== "quorum-observed" || evidence.executionEnabled !== false || evidence.releaseApprovalRequired !== true || !Number.isSafeInteger(evidence.observedAt) || Number(evidence.observedAt) <= 0 || Number(evidence.observedAt) > now + MAX_CLOCK_SKEW_MS || now - Number(evidence.observedAt) > MAX_OBSERVATION_AGE_MS) throw new Error("CCTP_ASSET_OBSERVATION_INVALID");
  const asset = strictObject(evidence.asset, ["chainId", "caip2", "address", "symbol", "name", "decimals", "implementationSlot"], "CCTP_ASSET_OBSERVATION_INVALID");
  if (asset.chainId !== BASE_SEPOLIA_CCTP_ASSET.chainId || asset.caip2 !== BASE_SEPOLIA_CCTP_ASSET.caip2 || normalizedAddress(asset.address, "CCTP_ASSET_OBSERVATION_INVALID") !== BASE_SEPOLIA_CCTP_ASSET.address || asset.symbol !== BASE_SEPOLIA_CCTP_ASSET.symbol || asset.name !== BASE_SEPOLIA_CCTP_ASSET.name || asset.decimals !== BASE_SEPOLIA_CCTP_ASSET.decimals || asset.implementationSlot !== BASE_SEPOLIA_CCTP_ASSET.implementationSlot) throw new Error("CCTP_ASSET_OBSERVATION_INVALID");
  if (!Array.isArray(evidence.observations) || evidence.observations.length !== 2) throw new Error("CCTP_ASSET_OBSERVATION_INVALID");
  const observations = evidence.observations.map((item) => {
    const observation = strictObject(item, ["readerId", "observedBlock", "proxyCodeHash", "implementationAddress", "implementationCodeHash", "name", "symbol", "decimals"], "CCTP_ASSET_OBSERVATION_INVALID");
    if (typeof observation.readerId !== "string" || !validReaderId(observation.readerId) || !Number.isSafeInteger(observation.observedBlock) || Number(observation.observedBlock) < 0 || typeof observation.proxyCodeHash !== "string" || !HEX_32.test(observation.proxyCodeHash) || typeof observation.implementationCodeHash !== "string" || !HEX_32.test(observation.implementationCodeHash) || observation.name !== BASE_SEPOLIA_CCTP_ASSET.name || observation.symbol !== BASE_SEPOLIA_CCTP_ASSET.symbol || observation.decimals !== BASE_SEPOLIA_CCTP_ASSET.decimals) throw new Error("CCTP_ASSET_OBSERVATION_INVALID");
    return { readerId: observation.readerId, observedBlock: observation.observedBlock as number, proxyCodeHash: observation.proxyCodeHash, implementationAddress: normalizedAddress(observation.implementationAddress, "CCTP_ASSET_OBSERVATION_INVALID"), implementationCodeHash: observation.implementationCodeHash, name: observation.name, symbol: observation.symbol, decimals: observation.decimals };
  });
  if (new Set(observations.map((item) => item.readerId.toLowerCase())).size !== 2 || Math.max(...observations.map((item) => item.observedBlock)) - Math.min(...observations.map((item) => item.observedBlock)) > MAX_HEAD_DIVERGENCE) throw new Error("CCTP_ASSET_OBSERVATION_INVALID");
  const identities = observations.map((item) => `${item.proxyCodeHash}:${item.implementationAddress.toLowerCase()}:${item.implementationCodeHash}:${item.name}:${item.symbol}:${item.decimals}`);
  if (new Set(identities).size !== 1) throw new Error("CCTP_ASSET_OBSERVATION_INVALID");
  return { status: "quorum-observed" as const, asset: { ...BASE_SEPOLIA_CCTP_ASSET, chainId: BASE_SEPOLIA_CCTP_ASSET.chainId.toString() }, observations, observedAt: evidence.observedAt as number, executionEnabled: false as const, releaseApprovalRequired: true as const };
}

function assertMonotonicHead(revision: number, payloadHash: string, head: CctpAssetReleaseHead): void {
  if (!Number.isSafeInteger(head.revision) || head.revision <= 0 || !HEX_32.test(head.payloadHash)) throw new Error("CCTP_ASSET_RELEASE_HEAD_INVALID");
  if (revision < head.revision) throw new Error("CCTP_ASSET_RELEASE_ROLLBACK_BLOCKED");
  if (revision === head.revision && payloadHash !== head.payloadHash) throw new Error("CCTP_ASSET_RELEASE_REVISION_CONFLICT");
}

function parseCanonicalTimestamp(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code);
  return parsed;
}

function validEvidenceUrls(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some((url) => typeof url !== "string" || !isSafeHttpsUrl(url)) || new Set(value).size !== value.length) throw new Error(code);
  return [...value] as string[];
}

function isSafeHttpsUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { return false; }
}

function validReaderId(value: string): boolean { return value.length <= 100 && /^(?=.{1,100}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value); }

function normalizedAddress(value: unknown, code: string): string {
  try { if (typeof value !== "string" || value === "0x0000000000000000000000000000000000000000") throw new Error(code); return getAddress(value); }
  catch { throw new Error(code); }
}

function strictObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(code);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) throw new Error(code);
  return object;
}
