import { Wallet, type Signer } from "ethers";
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA_CCTP_ASSET, type CctpAssetReleaseEvidence } from "./cctp-asset-release";
import { cctpSourceBytecodeVerificationArtifactSha256, type CctpSourceBytecodeVerificationArtifact } from "./cctp-source-bytecode-verification";
import {
  CCTP_ASSET_RELEASE_BOUNDARY_ID,
  canonicalSignedCctpAssetReleasePayload,
  cctpAssetObservationFingerprint,
  cctpAssetReleaseSourceFingerprint,
  revalidateVerifiedCctpAssetRelease,
  verifySignedCctpAssetReleaseManifest,
  type CctpAssetReleaseSourceDescriptor,
  type SignedCctpAssetReleaseManifest
} from "./cctp-asset-release-policy";

const now = 1_800_000_000_000;
const signer = Wallet.createRandom();
const otherSigner = Wallet.createRandom();
const source: CctpAssetReleaseSourceDescriptor = {
  schema: "realdex.cctp-asset-release-source.v1",
  id: "independent.cctp.asset.review",
  name: "Independent CCTP asset reviewer",
  signerAddress: signer.address,
  assetId: `eip155:84532/erc20:${BASE_SEPOLIA_CCTP_ASSET.address}`,
  evidenceUrls: ["https://review.example.org/source"]
};

function observation(changes: Partial<CctpAssetReleaseEvidence> = {}): CctpAssetReleaseEvidence {
  return {
    status: "quorum-observed",
    asset: BASE_SEPOLIA_CCTP_ASSET,
    observations: [
      { readerId: "sepolia.base.org", observedBlock: 20_000, proxyCodeHash: `0x${"1".repeat(64)}`, implementationAddress: "0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5", implementationCodeHash: `0x${"2".repeat(64)}`, name: "USDC", symbol: "USDC", decimals: 6 },
      { readerId: "base-sepolia-rpc.publicnode.com", observedBlock: 20_004, proxyCodeHash: `0x${"1".repeat(64)}`, implementationAddress: "0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5", implementationCodeHash: `0x${"2".repeat(64)}`, name: "USDC", symbol: "USDC", decimals: 6 }
    ],
    observedAt: now - 5_000,
    executionEnabled: false,
    releaseApprovalRequired: true,
    ...changes
  };
}

function verificationArtifact(evidence: CctpAssetReleaseEvidence = observation()): CctpSourceBytecodeVerificationArtifact {
  const identity = evidence.observations[0];
  const contract = (sourcePath: string, sourceDigit: string, compiledDigit: string, observedHash: string): CctpSourceBytecodeVerificationArtifact["contracts"]["proxy"] => ({
    compiledFullRuntimeKeccak256: `0x${compiledDigit.repeat(64)}`,
    logicRuntimeKeccak256: `0x${"8".repeat(64)}`,
    metadataMatched: false,
    metadataSha256: `sha256:${"9".repeat(64)}`,
    observedFullRuntimeKeccak256: observedHash,
    observedRuntimeBytes: 100,
    sourcePath,
    sourceSha256: `sha256:${sourceDigit.repeat(64)}`
  });
  return {
    asset: {
      caip19: `eip155:84532/erc20:${BASE_SEPOLIA_CCTP_ASSET.address}`,
      implementationAddress: identity.implementationAddress.toLowerCase(),
      implementationSlot: BASE_SEPOLIA_CCTP_ASSET.implementationSlot,
      proxyAddress: BASE_SEPOLIA_CCTP_ASSET.address,
      signatureCheckerAddress: "0x1111111111111111111111111111111111111111"
    },
    compiler: { optimizerEnabled: true, optimizerRuns: 10_000_000, reportedVersion: "0.6.12+commit.27d51765.Emscripten.clang", version: "0.6.12+commit.27d51765" },
    contracts: {
      proxy: contract("contracts/v1/FiatTokenProxy.sol", "3", "a", identity.proxyCodeHash),
      implementation: contract("contracts/v2/FiatTokenV2_2.sol", "4", "b", identity.implementationCodeHash),
      signatureChecker: contract("contracts/util/SignatureChecker.sol", "c", "d", `0x${"7".repeat(64)}`)
    },
    executionEnabled: false,
    explicitUserReleaseRequired: true,
    metadataVerified: false,
    network: { caip2: "eip155:84532", chainId: "84532", maximumHeadDivergence: 12, minimumObservedBlock: Math.min(...evidence.observations.map((item) => item.observedBlock)), readerIds: ["sepolia.base.org", "base-sepolia-rpc.publicnode.com"] },
    observedAt: new Date(now - 4_000).toISOString(),
    repository: { cleanTrackedTree: true, commitSha: "a".repeat(40), url: "https://github.com/circlefin/stablecoin-evm" },
    schema: "realdex.cctp-source-bytecode-verification.v1",
    signingEnabled: false,
    sourceTreeSha256: `sha256:${"6".repeat(64)}`,
    status: "verified-partial-runtime",
    submissionEnabled: false,
    verificationMode: "partial-runtime"
  };
}

async function signedManifest(options: { evidence?: CctpAssetReleaseEvidence; artifact?: CctpSourceBytecodeVerificationArtifact; signerWallet?: Signer; revision?: number; issuedAt?: number; expiresAt?: number; sourceValue?: CctpAssetReleaseSourceDescriptor } = {}): Promise<SignedCctpAssetReleaseManifest> {
  const evidence = options.evidence ?? observation();
  const artifact = options.artifact ?? verificationArtifact(evidence);
  const sourceValue = options.sourceValue ?? source;
  const identity = evidence.observations[0];
  const unsigned: Omit<SignedCctpAssetReleaseManifest, "signature"> = {
    schema: "realdex.signed-cctp-asset-release.v1",
    sourceId: sourceValue.id,
    sourceFingerprint: cctpAssetReleaseSourceFingerprint(sourceValue),
    revision: options.revision ?? 1,
    issuedAt: new Date(options.issuedAt ?? now - 1_000).toISOString(),
    expiresAt: new Date(options.expiresAt ?? now + 60_000).toISOString(),
    assetId: sourceValue.assetId,
    boundaryId: CCTP_ASSET_RELEASE_BOUNDARY_ID,
    observationFingerprint: cctpAssetObservationFingerprint(evidence, now),
    readerIds: [evidence.observations[0].readerId, evidence.observations[1].readerId],
    minimumObservedBlock: Math.min(...evidence.observations.map((item) => item.observedBlock)),
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
  return { ...unsigned, signature: await (options.signerWallet ?? signer).signMessage(canonicalSignedCctpAssetReleasePayload(unsigned)) };
}

describe("signed CCTP asset release review", () => {
  it("binds an independently pinned signer, exact source review, and fresh two-RPC observation without enabling execution", async () => {
    const evidence = observation();
    const artifact = verificationArtifact(evidence);
    const manifest = await signedManifest({ evidence, artifact });
    const verified = verifySignedCctpAssetReleaseManifest(manifest, source, cctpAssetReleaseSourceFingerprint(source), evidence, artifact, { now });
    expect(verified).toMatchObject({ status: "verified-design-gate", executionEnabled: false, signingEnabled: false, submissionEnabled: false, explicitUserReleaseRequired: true });
    expect(verified.manifest.sourceReview.repositoryUrl).toBe("https://github.com/circlefin/stablecoin-evm");
    expect(verified.manifest.sourceReview.verificationMode).toBe("partial-runtime");
    expect(revalidateVerifiedCctpAssetRelease(verified, evidence, now + 1_000).payloadHash).toBe(verified.payloadHash);
  });

  it("rejects an unpinned source, source substitution, and a different signer", async () => {
    const evidence = observation();
    const artifact = verificationArtifact(evidence);
    const manifest = await signedManifest({ evidence, artifact });
    expect(() => verifySignedCctpAssetReleaseManifest(manifest, source, `0x${"0".repeat(64)}`, evidence, artifact, { now })).toThrow("CCTP_ASSET_RELEASE_SOURCE_NOT_PINNED");
    const substituted = { ...source, name: "Substituted reviewer" };
    expect(() => verifySignedCctpAssetReleaseManifest(manifest, substituted, cctpAssetReleaseSourceFingerprint(substituted), evidence, artifact, { now })).toThrow("CCTP_ASSET_RELEASE_SOURCE_MISMATCH");
    const wrongSignature = await signedManifest({ evidence, signerWallet: otherSigner });
    expect(() => verifySignedCctpAssetReleaseManifest(wrongSignature, source, cctpAssetReleaseSourceFingerprint(source), evidence, artifact, { now })).toThrow("CCTP_ASSET_RELEASE_SIGNER_NOT_PINNED");
  });

  it("rejects observation substitution, stale evidence, malformed source review, and pre-observation approval", async () => {
    const evidence = observation();
    const artifact = verificationArtifact(evidence);
    const manifest = await signedManifest({ evidence, artifact });
    const changed = observation({ observations: [{ ...evidence.observations[0], implementationCodeHash: `0x${"9".repeat(64)}` }, { ...evidence.observations[1], implementationCodeHash: `0x${"9".repeat(64)}` }] });
    expect(() => verifySignedCctpAssetReleaseManifest(manifest, source, cctpAssetReleaseSourceFingerprint(source), changed, artifact, { now })).toThrow("CCTP_ASSET_RELEASE_OBSERVATION_MISMATCH");
    const stale = observation({ observedAt: now - 24 * 60 * 60 * 1_000 - 1 });
    expect(() => cctpAssetObservationFingerprint(stale, now)).toThrow("CCTP_ASSET_OBSERVATION_INVALID");
    const badReview = { ...manifest, sourceReview: { ...manifest.sourceReview, repositoryUrl: "https://example.org/fork" } };
    expect(() => verifySignedCctpAssetReleaseManifest(badReview, source, cctpAssetReleaseSourceFingerprint(source), evidence, artifact, { now })).toThrow("CCTP_ASSET_RELEASE_SOURCE_REVIEW_INVALID");
    const missingLibraryEvidence = { ...manifest, sourceReview: { ...manifest.sourceReview } } as Record<string, unknown>;
    delete (missingLibraryEvidence.sourceReview as Record<string, unknown>).signatureCheckerCodeHash;
    expect(() => verifySignedCctpAssetReleaseManifest(missingLibraryEvidence, source, cctpAssetReleaseSourceFingerprint(source), evidence, artifact, { now })).toThrow("CCTP_ASSET_RELEASE_SOURCE_REVIEW_INVALID");
    const predates = await signedManifest({ evidence, issuedAt: evidence.observedAt - 1 });
    expect(() => verifySignedCctpAssetReleaseManifest(predates, source, cctpAssetReleaseSourceFingerprint(source), evidence, artifact, { now })).toThrow("CCTP_ASSET_RELEASE_PREDATES_OBSERVATION");
  });

  it("rejects unsafe, substituted, observation-divergent, and stale bytecode artifacts", async () => {
    const evidence = observation();
    const artifact = verificationArtifact(evidence);
    const manifest = await signedManifest({ evidence, artifact });
    expect(() => verifySignedCctpAssetReleaseManifest(manifest, source, cctpAssetReleaseSourceFingerprint(source), evidence, { ...artifact, executionEnabled: true }, { now })).toThrow("CCTP_SOURCE_BYTECODE_ARTIFACT_INVALID");
    expect(() => verifySignedCctpAssetReleaseManifest(manifest, source, cctpAssetReleaseSourceFingerprint(source), evidence, { ...artifact, sourceTreeSha256: `sha256:${"e".repeat(64)}` }, { now })).toThrow("CCTP_ASSET_RELEASE_ARTIFACT_REVIEW_MISMATCH");
    expect(() => verifySignedCctpAssetReleaseManifest(manifest, source, cctpAssetReleaseSourceFingerprint(source), evidence, { ...artifact, unexpected: true }, { now })).toThrow("CCTP_SOURCE_BYTECODE_ARTIFACT_INVALID");

    const divergent = { ...artifact, contracts: { ...artifact.contracts, proxy: { ...artifact.contracts.proxy, observedFullRuntimeKeccak256: `0x${"9".repeat(64)}` } } };
    const divergentManifest = await signedManifest({ evidence, artifact: divergent });
    expect(() => verifySignedCctpAssetReleaseManifest(divergentManifest, source, cctpAssetReleaseSourceFingerprint(source), evidence, divergent, { now })).toThrow("CCTP_ASSET_RELEASE_ARTIFACT_OBSERVATION_MISMATCH");

    const stale = { ...artifact, observedAt: new Date(now - 24 * 60 * 60 * 1_000 - 1).toISOString() };
    const staleManifest = await signedManifest({ evidence, artifact: stale });
    expect(() => verifySignedCctpAssetReleaseManifest(staleManifest, source, cctpAssetReleaseSourceFingerprint(source), evidence, stale, { now })).toThrow("CCTP_ASSET_RELEASE_ARTIFACT_TIME_INVALID");
  });

  it("blocks expiry, rollback, revision conflicts, and mutation of disabled authority flags", async () => {
    const evidence = observation();
    const artifact = verificationArtifact(evidence);
    const expired = await signedManifest({ evidence, issuedAt: now - 120_000, expiresAt: now - 1 });
    expect(() => verifySignedCctpAssetReleaseManifest(expired, source, cctpAssetReleaseSourceFingerprint(source), evidence, artifact, { now })).toThrow("CCTP_ASSET_RELEASE_EXPIRED");
    const manifest = await signedManifest({ evidence, artifact, revision: 2 });
    const verified = verifySignedCctpAssetReleaseManifest(manifest, source, cctpAssetReleaseSourceFingerprint(source), evidence, artifact, { now });
    const rollback = await signedManifest({ evidence, revision: 1 });
    expect(() => verifySignedCctpAssetReleaseManifest(rollback, source, cctpAssetReleaseSourceFingerprint(source), evidence, artifact, { now, previousHead: { revision: 2, payloadHash: verified.payloadHash } })).toThrow("CCTP_ASSET_RELEASE_ROLLBACK_BLOCKED");
    const conflict = await signedManifest({ evidence, revision: 2, expiresAt: now + 120_000 });
    expect(() => verifySignedCctpAssetReleaseManifest(conflict, source, cctpAssetReleaseSourceFingerprint(source), evidence, artifact, { now, previousHead: { revision: 2, payloadHash: verified.payloadHash } })).toThrow("CCTP_ASSET_RELEASE_REVISION_CONFLICT");
    expect(() => revalidateVerifiedCctpAssetRelease({ ...verified, executionEnabled: true } as never, evidence, now + 1_000)).toThrow("CCTP_ASSET_RELEASE_VERIFICATION_INVALID");
    expect(() => revalidateVerifiedCctpAssetRelease({ ...verified, verificationArtifactSha256: `sha256:${"0".repeat(64)}` }, evidence, now + 1_000)).toThrow("CCTP_ASSET_RELEASE_VERIFICATION_INVALID");
    expect(() => revalidateVerifiedCctpAssetRelease({ ...verified, verificationArtifact: { ...verified.verificationArtifact, submissionEnabled: true } } as never, evidence, now + 1_000)).toThrow("CCTP_SOURCE_BYTECODE_ARTIFACT_INVALID");
  });
});
