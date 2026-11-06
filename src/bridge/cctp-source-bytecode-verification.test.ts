import { describe, expect, it } from "vitest";
import liveArtifact from "../../test/fixtures/cctp-base-sepolia-partial-runtime-2026-09-02.json";
import {
  cctpSourceBytecodeVerificationArtifactSha256,
  validateCctpSourceBytecodeVerificationArtifact
} from "./cctp-source-bytecode-verification";

describe("CCTP source bytecode verification artifact", () => {
  it("accepts the reproduced Circle artifact and derives the generator hash", () => {
    const artifact = validateCctpSourceBytecodeVerificationArtifact(liveArtifact);
    expect(artifact.status).toBe("verified-partial-runtime");
    expect(artifact.metadataVerified).toBe(false);
    expect(cctpSourceBytecodeVerificationArtifactSha256(artifact)).toBe("sha256:fdbb428ac2131878ea6b8100b458f7469209b796e58e1a5603e44cf70cde3856");
  });

  it("rejects compiler drift, unsafe authority, false metadata claims, and extra fields", () => {
    expect(() => validateCctpSourceBytecodeVerificationArtifact({ ...liveArtifact, compiler: { ...liveArtifact.compiler, optimizerRuns: 200 } })).toThrow("CCTP_SOURCE_BYTECODE_ARTIFACT_INVALID");
    expect(() => validateCctpSourceBytecodeVerificationArtifact({ ...liveArtifact, signingEnabled: true })).toThrow("CCTP_SOURCE_BYTECODE_ARTIFACT_INVALID");
    expect(() => validateCctpSourceBytecodeVerificationArtifact({ ...liveArtifact, metadataVerified: true })).toThrow("CCTP_SOURCE_BYTECODE_ARTIFACT_INVALID");
    expect(() => validateCctpSourceBytecodeVerificationArtifact({ ...liveArtifact, extra: true })).toThrow("CCTP_SOURCE_BYTECODE_ARTIFACT_INVALID");
  });

  it("rejects contract evidence tampering and noncanonical addresses", () => {
    expect(() => validateCctpSourceBytecodeVerificationArtifact({ ...liveArtifact, contracts: { ...liveArtifact.contracts, proxy: { ...liveArtifact.contracts.proxy, metadataMatched: true } } })).toThrow("CCTP_SOURCE_BYTECODE_ARTIFACT_INVALID");
    expect(() => validateCctpSourceBytecodeVerificationArtifact({ ...liveArtifact, asset: { ...liveArtifact.asset, implementationAddress: "0xD74Cc5D436923B8ba2C179B4bca2841d8A52C5B5" } })).toThrow("CCTP_SOURCE_BYTECODE_ARTIFACT_INVALID");
  });
});
