import { Wallet, type Signer } from "ethers";
import { describe, expect, it } from "vitest";
import deploymentReport from "./fixtures/cctp-deployment-metadata-report-v2.json";
import { BASE_SEPOLIA_CCTP_ASSET, type CctpAssetReleaseEvidence } from "./cctp-asset-release";
import {
  canonicalSignedCctpAssetReleasePayload,
  cctpAssetObservationFingerprint,
  cctpAssetReleaseSourceFingerprint,
  revalidateVerifiedCctpAssetRelease,
  verifySignedCctpAssetReleaseManifest,
  type CctpAssetReleaseSourceDescriptor,
  type SignedCctpAssetReleaseManifest,
  type VerifiedCctpAssetReleaseManifest
} from "./cctp-asset-release-policy";
import { cctpSourceBytecodeVerificationArtifactSha256, type CctpSourceBytecodeVerificationArtifact } from "./cctp-source-bytecode-verification";
import {
  canonicalCctpMetadataReviewPayload,
  cctpDeploymentMetadataReportSha256,
  revalidateCctpDeploymentMetadataReview,
  validateCctpDeploymentMetadataReport,
  verifyCctpDeploymentMetadataReview,
  type CctpDeploymentMetadataReport,
  type SignedCctpMetadataReview
} from "./cctp-deployment-metadata-review";

const report = deploymentReport as unknown as CctpDeploymentMetadataReport;
const reportAt = Date.parse(report.observedAt);
const now = reportAt + 5_000;
const sourceSigner = Wallet.createRandom();
const otherSigner = Wallet.createRandom();
const source: CctpAssetReleaseSourceDescriptor = {
  schema: "realdex.cctp-asset-release-source.v1",
  id: "independent.cctp.asset.review",
  name: "Independent CCTP asset reviewer",
  signerAddress: sourceSigner.address,
  assetId: `eip155:84532/erc20:${BASE_SEPOLIA_CCTP_ASSET.address}`,
  evidenceUrls: ["https://review.example.org/source"]
};

function evidence(): CctpAssetReleaseEvidence {
  const first = report.network.minimumObservedBlock;
  return {
    status: "quorum-observed",
    asset: BASE_SEPOLIA_CCTP_ASSET,
    observations: report.network.readerIds.map((readerId) => ({
      readerId,
      observedBlock: first,
      proxyCodeHash: report.contracts.proxy.observedFullRuntimeKeccak256,
      implementationAddress: report.asset.implementationAddress,
      implementationCodeHash: report.contracts.implementation.observedFullRuntimeKeccak256,
      name: "USDC",
      symbol: "USDC",
      decimals: 6
    })) as CctpAssetReleaseEvidence["observations"],
    observedAt: reportAt,
    executionEnabled: false,
    releaseApprovalRequired: true
  };
}

function syntheticArtifact(observed: CctpAssetReleaseEvidence = evidence()): CctpSourceBytecodeVerificationArtifact {
  const identity = observed.observations[0];
  const contract = (sourcePath: string, compiled: string, logic: string, sourceHash: string, observedHash: string, bytes: number): CctpSourceBytecodeVerificationArtifact["contracts"]["proxy"] => ({
    compiledFullRuntimeKeccak256: `0x${compiled.repeat(64)}`,
    logicRuntimeKeccak256: `0x${logic.repeat(64)}`,
    metadataMatched: false,
    metadataSha256: `sha256:${"9".repeat(64)}`,
    observedFullRuntimeKeccak256: observedHash,
    observedRuntimeBytes: bytes,
    sourcePath,
    sourceSha256: `sha256:${sourceHash.repeat(64)}`
  });
  return {
    asset: {
      caip19: report.asset.caip19,
      implementationAddress: identity.implementationAddress.toLowerCase(),
      implementationSlot: report.asset.implementationSlot,
      proxyAddress: report.asset.proxyAddress,
      signatureCheckerAddress: report.asset.signatureCheckerAddress.toLowerCase()
    },
    compiler: {
      optimizerEnabled: true,
      optimizerRuns: 10_000_000,
      reportedVersion: "0.6.12+commit.27d51765.Emscripten.clang",
      version: "0.6.12+commit.27d51765"
    },
    contracts: {
      proxy: contract("contracts/v1/FiatTokenProxy.sol", "a", "1", "3", report.contracts.proxy.observedFullRuntimeKeccak256, report.contracts.proxy.observedRuntimeBytes as number),
      implementation: contract("contracts/v2/FiatTokenV2_2.sol", "b", "2", "4", report.contracts.implementation.observedFullRuntimeKeccak256, report.contracts.implementation.observedRuntimeBytes as number),
      signatureChecker: contract("contracts/util/SignatureChecker.sol", "c", "3", "5", report.contracts.signatureChecker.observedFullRuntimeKeccak256, report.contracts.signatureChecker.observedRuntimeBytes as number)
    },
    executionEnabled: false,
    explicitUserReleaseRequired: true,
    metadataVerified: false,
    network: {
      caip2: report.network.caip2 as "eip155:84532",
      chainId: report.network.chainId as "84532",
      maximumHeadDivergence: 12,
      minimumObservedBlock: report.network.minimumObservedBlock,
      readerIds: ["sepolia.base.org", "base-sepolia-rpc.publicnode.com"]
    },
    observedAt: new Date(reportAt + 1_000).toISOString(),
    repository: { cleanTrackedTree: true, commitSha: deploymentReport.repository.currentHead, url: "https://github.com/circlefin/stablecoin-evm" },
    schema: "realdex.cctp-source-bytecode-verification.v1",
    signingEnabled: false,
    sourceTreeSha256: `sha256:${"6".repeat(64)}`,
    status: "verified-partial-runtime",
    submissionEnabled: false,
    verificationMode: "partial-runtime"
  };
}

async function signedRelease(options: { signer?: Signer; evidence?: CctpAssetReleaseEvidence; artifact?: CctpSourceBytecodeVerificationArtifact } = {}): Promise<SignedCctpAssetReleaseManifest> {
  const observed = options.evidence ?? evidence();
  const artifact = options.artifact ?? syntheticArtifact(observed);
  const identity = observed.observations[0];
  const unsigned: Omit<SignedCctpAssetReleaseManifest, "signature"> = {
    schema: "realdex.signed-cctp-asset-release.v1",
    sourceId: source.id,
    sourceFingerprint: cctpAssetReleaseSourceFingerprint(source),
    revision: 1,
    issuedAt: new Date(reportAt + 1_000).toISOString(),
    expiresAt: new Date(reportAt + 120_000).toISOString(),
    assetId: source.assetId,
    boundaryId: "cctp-base-usdc-signed-release-review-v1",
    observationFingerprint: cctpAssetObservationFingerprint(observed, now),
    readerIds: [observed.observations[0].readerId, observed.observations[1].readerId],
    minimumObservedBlock: Math.min(...observed.observations.map((item) => item.observedBlock)),
    proxyCodeHash: identity.proxyCodeHash,
    implementationAddress: identity.implementationAddress,
    implementationCodeHash: identity.implementationCodeHash,
    sourceReview: {
      repositoryUrl: "https://github.com/circlefin/stablecoin-evm",
      commitSha: artifact.repository.commitSha,
      compilerVersion: "0.6.12+commit.27d51765",
      optimizerRuns: 10_000_000,
      verificationMode: "partial-runtime",
      sourceTreeSha256: artifact.sourceTreeSha256,
      proxySourceSha256: artifact.contracts.proxy.sourceSha256,
      implementationSourceSha256: artifact.contracts.implementation.sourceSha256,
      signatureCheckerAddress: artifact.asset.signatureCheckerAddress,
      signatureCheckerCodeHash: artifact.contracts.signatureChecker.observedFullRuntimeKeccak256,
      verificationArtifactSha256: cctpSourceBytecodeVerificationArtifactSha256(artifact)
    },
    recommendation: "approve-for-explicit-user-release",
    evidenceUrls: ["https://review.example.org/report"]
  };
  return { ...unsigned, signature: await (options.signer ?? sourceSigner).signMessage(canonicalSignedCctpAssetReleasePayload(unsigned)) };
}

async function verifiedRelease(): Promise<{ release: VerifiedCctpAssetReleaseManifest; observed: CctpAssetReleaseEvidence }> {
  const observed = evidence();
  const artifact = syntheticArtifact(observed);
  const manifest = await signedRelease({ evidence: observed, artifact });
  return { release: verifySignedCctpAssetReleaseManifest(manifest, source, cctpAssetReleaseSourceFingerprint(source), observed, artifact, { now }), observed };
}

function unsignedSupplement(overrides: Partial<Omit<SignedCctpMetadataReview, "signature">> = {}): Omit<SignedCctpMetadataReview, "signature"> {
  return {
    schema: "realdex.signed-cctp-metadata-review.v1",
    sourceFingerprint: cctpAssetReleaseSourceFingerprint(source),
    releasePayloadHash: "0x" + "0".repeat(64),
    reportSha256: cctpDeploymentMetadataReportSha256(report),
    issuedAt: new Date(reportAt + 2_000).toISOString(),
    expiresAt: new Date(reportAt + 60_000).toISOString(),
    ...overrides
  };
}

async function signedSupplement(release: VerifiedCctpAssetReleaseManifest, overrides: Partial<Omit<SignedCctpMetadataReview, "signature">> = {}, signer: Signer = sourceSigner): Promise<SignedCctpMetadataReview> {
  const unsigned = { ...unsignedSupplement({ releasePayloadHash: release.payloadHash }), ...overrides };
  return { ...unsigned, signature: await signer.signMessage(canonicalCctpMetadataReviewPayload(unsigned)) };
}

describe("CCTP deployment metadata review supplement", () => {
  it("accepts the public historical report and binds a fresh signed parent release review", async () => {
    expect(cctpDeploymentMetadataReportSha256(report)).toBe("sha256:7366ae1861901d79f22d7714e4b9e82b4141b227855498364158d11f15a708b1");
    const { release, observed } = await verifiedRelease();
    const signed = await signedSupplement(release);
    const verified = verifyCctpDeploymentMetadataReview(signed, report, release, cctpAssetReleaseSourceFingerprint(source), observed, now);
    expect(verified).toMatchObject({ status: "verified-metadata-supplement", executionEnabled: false, signingEnabled: false, submissionEnabled: false, releaseEligible: false, reportSha256: "sha256:7366ae1861901d79f22d7714e4b9e82b4141b227855498364158d11f15a708b1", releasePayloadHash: release.payloadHash });
  });

  it("rejects wrong signer, an unpinned external source fingerprint, and changed parent binding", async () => {
    const { release, observed } = await verifiedRelease();
    const wrongSigner = await signedSupplement(release, {}, otherSigner);
    expect(() => verifyCctpDeploymentMetadataReview(wrongSigner, report, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
    const signed = await signedSupplement(release);
    expect(() => verifyCctpDeploymentMetadataReview(signed, report, release, "0x" + "0".repeat(64), observed, now)).toThrow();
    const changed = await signedSupplement(release, { releasePayloadHash: "0x" + "1".repeat(64) });
    expect(() => verifyCctpDeploymentMetadataReview(changed, report, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
    const structurallyAltered = structuredClone(report) as CctpDeploymentMetadataReport & { repository: { currentHead: string } };
    structurallyAltered.repository.currentHead = "0".repeat(40);
    const signedForAlteredReport = await signedSupplement(release);
    expect(() => verifyCctpDeploymentMetadataReview(signedForAlteredReport, structurallyAltered, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
  });

  it("rejects altered report content after signing and every unsafe report shape", async () => {
    const { release, observed } = await verifiedRelease();
    const signed = await signedSupplement(release);
    const altered = { ...report, status: "verified-mixed-runtime" };
    expect(() => verifyCctpDeploymentMetadataReview(signed, altered, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
    const malformedReports: unknown[] = [
      { ...report, executionEnabled: true },
      { ...report, fullMetadataContracts: ["proxy"], partialMetadataContracts: ["implementation", "signatureChecker"] },
      { ...report, contracts: { ...report.contracts, proxy: { ...report.contracts.proxy, metadataJson: "altered" } } },
      { ...report, contracts: { ...report.contracts, implementation: { ...report.contracts.implementation, metadataJsonSha256: "sha256:" + "0".repeat(64) } } },
      { ...report, contracts: { ...report.contracts, implementation: { ...report.contracts.implementation, sourceHashes: { ...(report.contracts.implementation.sourceHashes as Record<string, unknown>), altered: "0x" + "0".repeat(64) } } } },
      { ...report, contracts: { ...report.contracts, implementation: { ...report.contracts.implementation, linkReferences: { broken: [] } } } },
      { ...report, contracts: { ...report.contracts, implementation: { ...report.contracts.implementation, linkReferences: { "/Users/quang.lam/Documents/GitHub/stablecoin-evm-private-usdc-cbase-testnet/contracts/util/SignatureChecker.sol": { SignatureChecker: [{ start: 18392, length: 20 }, { start: 20106, length: 20 }] } } } } },
      { ...report, network: { ...report.network, caip2: "eip155:1" } },
      { ...report, network: { ...report.network, readerIds: ["same", "same"] } },
      { ...report, contracts: { ...report.contracts, proxy: { ...report.contracts.proxy, observedFullRuntimeKeccak256: "0x" + "0".repeat(64) } } }
    ];
    for (const malformed of malformedReports) expect(() => validateCctpDeploymentMetadataReport(malformed)).toThrow();
    const blockDivergence = { ...report, network: { ...report.network, minimumObservedBlock: report.network.minimumObservedBlock - 13 } };
    expect(() => validateCctpDeploymentMetadataReport(blockDivergence)).not.toThrow();
    const blockDivergenceSigned = await signedSupplement(release, { reportSha256: cctpDeploymentMetadataReportSha256(blockDivergence) });
    expect(() => verifyCctpDeploymentMetadataReview(blockDivergenceSigned, blockDivergence, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
  });

  it("rejects supplements predating the report, expired, or exceeding the parent expiry", async () => {
    const { release, observed } = await verifiedRelease();
    const predates = await signedSupplement(release, { issuedAt: new Date(reportAt - 1).toISOString() });
    expect(() => verifyCctpDeploymentMetadataReview(predates, report, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
    const expired = await signedSupplement(release, { expiresAt: new Date(now - 1).toISOString() });
    expect(() => verifyCctpDeploymentMetadataReview(expired, report, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
    const exceeds = await signedSupplement(release, { expiresAt: new Date(reportAt + 121_000).toISOString() });
    expect(() => verifyCctpDeploymentMetadataReview(exceeds, report, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
    const future = await signedSupplement(release, { issuedAt: new Date(now + 1).toISOString() });
    expect(() => verifyCctpDeploymentMetadataReview(future, report, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
    const staleReport = { ...report, observedAt: new Date(reportAt - 86_400_001).toISOString() };
    const staleSigned = await signedSupplement(release, { reportSha256: cctpDeploymentMetadataReportSha256(staleReport) });
    expect(() => verifyCctpDeploymentMetadataReview(staleSigned, staleReport, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
  });

  it("revalidates the parent review and never lets mutated cached authority enable execution", async () => {
    const { release, observed } = await verifiedRelease();
    const signed = await signedSupplement(release);
    const mutated = { ...release, executionEnabled: true as const } as never;
    expect(() => verifyCctpDeploymentMetadataReview(signed, report, mutated, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
    const cached = { ...release, manifest: { ...release.manifest, sourceReview: { ...release.manifest.sourceReview, signatureCheckerCodeHash: "0x" + "0".repeat(64) } } } as never;
    expect(() => verifyCctpDeploymentMetadataReview(signed, report, cached, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
    expect(revalidateVerifiedCctpAssetRelease(release, observed, now)).toMatchObject({ executionEnabled: false, signingEnabled: false, submissionEnabled: false });
    const checked = verifyCctpDeploymentMetadataReview(signed, report, release, cctpAssetReleaseSourceFingerprint(source), observed, now);
    expect(revalidateCctpDeploymentMetadataReview(checked, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toMatchObject({ executionEnabled: false, signingEnabled: false, submissionEnabled: false, releaseEligible: false });
    expect(() => revalidateCctpDeploymentMetadataReview({ ...checked, executionEnabled: true }, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
    const cachedReport = { ...checked, report: { ...checked.report, observedAt: new Date(reportAt - 1).toISOString() } };
    expect(() => revalidateCctpDeploymentMetadataReview(cachedReport, release, cctpAssetReleaseSourceFingerprint(source), observed, now)).toThrow();
  });
});
