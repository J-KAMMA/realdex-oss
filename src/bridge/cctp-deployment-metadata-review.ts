import { base58 } from "@scure/base";
import { getAddress, getBytes, keccak256, sha256, toUtf8Bytes, verifyMessage } from "ethers";
import { BASE_SEPOLIA_CCTP_ASSET, type CctpAssetReleaseEvidence } from "./cctp-asset-release";
import { revalidateVerifiedCctpAssetRelease, type VerifiedCctpAssetReleaseManifest } from "./cctp-asset-release-policy";

// NOTE: this string is the source path Circle's own build embedded in the compiler
// metadata of the deployed testnet USDC contracts. It is public on-chain data of a
// third party, not a path of this project, and it cannot be rewritten: the metadata
// hash, source hashes and IPFS hash pinned below are computed over it.
const PREFIX = "/Users/quang.lam/Documents/GitHub/stablecoin-evm-private-usdc-cbase-testnet/";
const VERSION = "0.6.12+commit.27d51765";
const HEX = /^0x[0-9a-f]{64}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const DAY = 86_400_000;
const LIBRARY = "0xba3b60c21e28c41df4babd90f228e1d368627da6";
const IMPLEMENTATION = "0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5";
const READERS = ["sepolia.base.org", "base-sepolia-rpc.publicnode.com"];
const NAMES = ["proxy", "implementation", "signatureChecker"] as const;
type ContractName = typeof NAMES[number];

// This profile is deliberately specific to the reproduced deployment. Upgrades
// require a separately reviewed profile, not acceptance of report-supplied pins.
const PROFILES = {
  proxy: {
    path: "contracts/v1/FiatTokenProxy.sol", count: 5, bytes: 1798,
    sources: "6e41dbe2071ea7818c3e3cbba2fd7b5381ecbd5bfb1fb457bf7ec90bf91846a3",
    metadata: "174a4d76895ad743bb82bdf2c4c4342dc3c6cd31bca771dadee3ebd3b4501a3b",
    runtime: "edc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c",
    logic: "22b3d1bd9fee890cffe827da7e23e808ed91565afb9840f95f6de7ff6fd3122a",
    ipfs: "6f0bb189a04c9e932c2fc652002537537a56c29703f60e541f9d2fffcf6f1e17"
  },
  implementation: {
    path: "contracts/v2/FiatTokenV2_2.sol", count: 23, bytes: 23464,
    sources: "3759ae28c4473d4c0885944cfba12d2fbcfc44d8c53aa777b089bdba5d79a64c",
    metadata: "bd27843f7f59f04bcc607c7d89e60b6c17c845f6477b32e8084f05b9f2dff091",
    runtime: "1254951e5483b882fd5def9452f58fe786eb3380c0bf9bb2744fa21a0a97a16c",
    logic: "16934adee93749d6b62664c4c098dd18eec179d174975d452cb34f5a51966684",
    ipfs: "5ae9213f3326609a13fe260780649da5cf6df829d65cde071938cccf82086814"
  },
  signatureChecker: {
    path: "contracts/util/SignatureChecker.sol", count: 3, bytes: 1741,
    sources: "0f78b59e64d711f211da3670250b0cf03ce92ecef8c9e1036a5f844c29adc5cb",
    metadata: "d8fa2eed10a3226a738419e43d2d13685baa72d519c9122b603050f8c6b5ecc1",
    runtime: "0855e691adf48a1a47437ec347119ebfea7d3997af9a17f253178569753665c0",
    logic: "f37a86ef0e7b32bcfae4ea9fe0b3bd0e3cc061a5097162b47d8497c88b695354",
    ipfs: "cbf44f825a44a16bf35eb3b9027cf0accfda6b66bbb0dd6be40d11b35122c6f9"
  }
} as const;

export type CctpDeploymentMetadataReport = {
  [key: string]: unknown;
  observedAt: string;
  asset: { caip19: string; proxyAddress: string; implementationAddress: string; signatureCheckerAddress: string; implementationSlot: string };
  network: { caip2: string; chainId: string; maximumHeadDivergence: number; minimumObservedBlock: number; readerIds: string[] };
  contracts: Record<ContractName, { [key: string]: unknown; observedFullRuntimeKeccak256: string; metadataJson: string }>;
};

export type SignedCctpMetadataReview = {
  schema: "realdex.signed-cctp-metadata-review.v1";
  sourceFingerprint: string;
  releasePayloadHash: string;
  reportSha256: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
};

export function validateCctpDeploymentMetadataReport(value: unknown): CctpDeploymentMetadataReport {
  const r = object(value, ["schema", "status", "executionEnabled", "signingEnabled", "submissionEnabled", "releaseEligible", "explicitUserReleaseRequired", "repository", "compiler", "deploymentSourcePrefix", "network", "asset", "contracts", "fullMetadataContracts", "partialMetadataContracts", "metadataVerified", "observedAt"]);
  if (r.schema !== "realdex.cctp-deployment-metadata-report.v2" || r.status !== "verified-full-runtime" || r.metadataVerified !== true || r.executionEnabled !== false || r.signingEnabled !== false || r.submissionEnabled !== false || r.releaseEligible !== false || r.explicitUserReleaseRequired !== true || r.deploymentSourcePrefix !== PREFIX) invalid();
  timestamp(r.observedAt);
  equal(r.fullMetadataContracts, NAMES); equal(r.partialMetadataContracts, []);
  const repository = object(r.repository, ["url", "currentHead", "deploymentCommit", "cleanTrackedTree"]);
  if (repository.url !== "https://github.com/circlefin/stablecoin-evm" || repository.deploymentCommit !== "a1b5455f1779d8840b6b53cc562f5cc3d0a4875d" || repository.cleanTrackedTree !== true || typeof repository.currentHead !== "string" || !/^[0-9a-f]{40}$/.test(repository.currentHead)) invalid();
  equal(r.compiler, { version: VERSION, reportedVersion: `${VERSION}.Emscripten.clang`, optimizerEnabled: true, optimizerRuns: 10_000_000, evmVersion: "istanbul" });
  const network = object(r.network, ["caip2", "chainId", "readerIds", "minimumObservedBlock", "maximumHeadDivergence"]);
  if (network.caip2 !== "eip155:84532" || network.chainId !== "84532" || network.maximumHeadDivergence !== 12 || !Number.isSafeInteger(network.minimumObservedBlock) || Number(network.minimumObservedBlock) < 0) invalid();
  equal(network.readerIds, READERS);
  equal(r.asset, { caip19: `eip155:84532/erc20:${BASE_SEPOLIA_CCTP_ASSET.address}`, proxyAddress: BASE_SEPOLIA_CCTP_ASSET.address, implementationSlot: BASE_SEPOLIA_CCTP_ASSET.implementationSlot, implementationAddress: IMPLEMENTATION, signatureCheckerAddress: LIBRARY });
  const contracts = object(r.contracts, NAMES);
  for (const name of NAMES) {
    const profile = PROFILES[name];
    const c = object(contracts[name], ["verificationMode", "metadataMatched", "sourcePath", "sourceCount", "sourceSetSha256", "sourceHashes", "metadataJsonSha256", "metadataJson", "linkingProfile", "linkReferences", "logicRuntimeKeccak256", "compiledFullRuntimeKeccak256", "observedFullRuntimeKeccak256", "observedRuntimeBytes", "compiledMetadata", "observedMetadata"]);
    if (c.verificationMode !== "full-runtime" || c.metadataMatched !== true || c.sourcePath !== `${PREFIX}${profile.path}` || c.sourceCount !== profile.count || c.observedRuntimeBytes !== profile.bytes || c.compiledFullRuntimeKeccak256 !== `0x${profile.runtime}` || c.observedFullRuntimeKeccak256 !== `0x${profile.runtime}` || c.logicRuntimeKeccak256 !== `0x${profile.logic}`) invalid();
    const sources = object(c.sourceHashes);
    if (Object.keys(sources).length !== profile.count || Object.entries(sources).some(([key, hash]) => key.length > 1000 || typeof hash !== "string" || !HEX.test(hash)) || digest(canonical(sources)) !== `sha256:${profile.sources}` || c.sourceSetSha256 !== `sha256:${profile.sources}`) invalid();
    if (typeof c.metadataJson !== "string" || c.metadataJson.length > 100_000 || digest(c.metadataJson) !== `sha256:${profile.metadata}` || c.metadataJsonSha256 !== `sha256:${profile.metadata}`) invalid();
    const metadata = { cborHex: `0xa2646970667358221220${profile.ipfs}64736f6c634300060c`, lengthBytes: 51, ipfsCidV0: base58.encode(getBytes(`0x1220${profile.ipfs}`)), ipfsMultihashSha256: `sha256:${profile.ipfs}`, solcVersion: "0.6.12" };
    equal(c.compiledMetadata, metadata); equal(c.observedMetadata, metadata);
    if (c.linkingProfile !== (name === "implementation" ? "post-compilation-link" : "no-external-library-link")) invalid();
    equal(c.linkReferences, name === "implementation" ? { [`${PREFIX}contracts/util/SignatureChecker.sol`]: { SignatureChecker: [{ start: 18391, length: 20 }, { start: 20106, length: 20 }] } } : {});
  }
  return structuredClone(value) as CctpDeploymentMetadataReport;
}

export function cctpDeploymentMetadataReportSha256(value: unknown): string {
  return digest(`${canonical(validateCctpDeploymentMetadataReport(value))}\n`);
}

export function canonicalCctpMetadataReviewPayload(value: Omit<SignedCctpMetadataReview, "signature">): string {
  return `RealDEX signed CCTP deployment metadata supplement v1\n${canonical(unsignedReview(value))}`;
}

export function verifyCctpDeploymentMetadataReview(
  signedValue: unknown, reportValue: unknown, releaseValue: VerifiedCctpAssetReleaseManifest,
  expectedSourceFingerprint: string, observation: CctpAssetReleaseEvidence, now = Date.now()
) {
  if (!Number.isSafeInteger(now) || now <= 0 || !HEX.test(expectedSourceFingerprint) || releaseValue?.sourceFingerprint !== expectedSourceFingerprint) invalid();
  // Recheck the original signature and artifact; an embedded source is not a trust root.
  const release = revalidateVerifiedCctpAssetRelease(releaseValue, observation, now);
  if (release.sourceFingerprint !== expectedSourceFingerprint) invalid();
  const signed = object(signedValue, ["schema", "sourceFingerprint", "releasePayloadHash", "reportSha256", "issuedAt", "expiresAt", "signature"]);
  if (typeof signed.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signed.signature)) invalid();
  const { signature, ...unsigned } = signed;
  const manifest = unsignedReview(unsigned);
  const report = validateCctpDeploymentMetadataReport(reportValue);
  const reportSha256 = cctpDeploymentMetadataReportSha256(report);
  const issuedAt = timestamp(manifest.issuedAt), expiresAt = timestamp(manifest.expiresAt), observedAt = timestamp(report.observedAt);
  if (manifest.sourceFingerprint !== expectedSourceFingerprint || manifest.releasePayloadHash !== release.payloadHash || manifest.reportSha256 !== reportSha256
    || issuedAt > now || issuedAt < timestamp(release.manifest.issuedAt) || observedAt > issuedAt || now - observedAt > DAY
    || expiresAt <= now || expiresAt <= issuedAt || expiresAt > timestamp(release.manifest.expiresAt)) invalid();
  equal(report.network.readerIds, release.manifest.readerIds);
  if (report.network.minimumObservedBlock > release.manifest.minimumObservedBlock || release.manifest.minimumObservedBlock - report.network.minimumObservedBlock > 12
    || report.asset.implementationAddress !== release.manifest.implementationAddress.toLowerCase()
    || report.asset.signatureCheckerAddress !== release.manifest.sourceReview.signatureCheckerAddress.toLowerCase()
    || report.contracts.proxy.observedFullRuntimeKeccak256 !== release.manifest.proxyCodeHash
    || report.contracts.implementation.observedFullRuntimeKeccak256 !== release.manifest.implementationCodeHash
    || report.contracts.signatureChecker.observedFullRuntimeKeccak256 !== release.manifest.sourceReview.signatureCheckerCodeHash) invalid();
  const payload = canonicalCctpMetadataReviewPayload(manifest);
  try { if (getAddress(verifyMessage(payload, signature)) !== release.source.signerAddress) invalid(); }
  catch { invalid(); }
  return {
    schema: "realdex.verified-cctp-metadata-review.v1" as const,
    status: "verified-metadata-supplement" as const,
    executionEnabled: false as const, signingEnabled: false as const, submissionEnabled: false as const,
    releaseEligible: false as const, explicitUserReleaseRequired: true as const,
    reportSha256, releasePayloadHash: release.payloadHash, payloadHash: keccak256(toUtf8Bytes(payload)),
    manifest: { ...manifest, signature }, report, verifiedAt: now
  };
}

function unsignedReview(value: unknown): Omit<SignedCctpMetadataReview, "signature"> {
  const v = object(value, ["schema", "sourceFingerprint", "releasePayloadHash", "reportSha256", "issuedAt", "expiresAt"]);
  if (v.schema !== "realdex.signed-cctp-metadata-review.v1" || typeof v.sourceFingerprint !== "string" || !HEX.test(v.sourceFingerprint) || typeof v.releasePayloadHash !== "string" || !HEX.test(v.releasePayloadHash) || typeof v.reportSha256 !== "string" || !SHA.test(v.reportSha256)) invalid();
  timestamp(v.issuedAt); timestamp(v.expiresAt);
  return { ...v } as Omit<SignedCctpMetadataReview, "signature">;
}

export function revalidateCctpDeploymentMetadataReview(
  value: unknown, release: VerifiedCctpAssetReleaseManifest, expectedSourceFingerprint: string,
  observation: CctpAssetReleaseEvidence, now = Date.now()
) {
  const v = object(value, ["schema", "status", "executionEnabled", "signingEnabled", "submissionEnabled", "releaseEligible", "explicitUserReleaseRequired", "reportSha256", "releasePayloadHash", "payloadHash", "manifest", "report", "verifiedAt"]);
  if (v.schema !== "realdex.verified-cctp-metadata-review.v1" || v.status !== "verified-metadata-supplement" || v.executionEnabled !== false || v.signingEnabled !== false || v.submissionEnabled !== false || v.releaseEligible !== false || v.explicitUserReleaseRequired !== true || !Number.isSafeInteger(v.verifiedAt) || Number(v.verifiedAt) <= 0 || Number(v.verifiedAt) > now) invalid();
  const checked = verifyCctpDeploymentMetadataReview(v.manifest, v.report, release, expectedSourceFingerprint, observation, now);
  if (v.reportSha256 !== checked.reportSha256 || v.releasePayloadHash !== checked.releasePayloadHash || v.payloadHash !== checked.payloadHash) invalid();
  return checked;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || new Date(parsed).toISOString() !== value) invalid();
  return parsed;
}

function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const v = value as Record<string, unknown>;
  if (keys && (Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key)))) invalid();
  return v;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) as string;
}
function digest(value: string): string { return `sha256:${sha256(toUtf8Bytes(value)).slice(2)}`; }
function equal(value: unknown, expected: unknown): void { if (canonical(value) !== canonical(expected)) invalid(); }
function invalid(): never { throw new Error("CCTP_DEPLOYMENT_METADATA_REVIEW_INVALID"); }
