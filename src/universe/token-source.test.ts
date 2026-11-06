import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import type { UniversalAsset } from "./types";
import {
  assetSourceFingerprint,
  canonicalSignedAssetManifestPayload,
  findAssetCollisions,
  verifyEvmAssetOnChain,
  verifySignedAssetManifest,
  type AssetSourceDescriptor,
  type SignedAssetManifest
} from "./token-source";

const now = Date.parse("2026-09-01T00:00:00.000Z");
const asset: UniversalAsset = {
  assetType: "eip155:1/erc20:0x6B175474E89094C44Da98b954EedeAC495271d0F",
  symbol: "DAI", name: "Dai Stablecoin", decimals: 18,
  provenance: "signed-list", execution: "design-gate"
};

async function fixture(overrides: Partial<Omit<SignedAssetManifest, "signature">> = {}) {
  const signer = Wallet.createRandom();
  const source: AssetSourceDescriptor = {
    schema: "localswap.asset-source.v1", id: "example.assets", name: "Example source",
    signerAddress: signer.address, allowedChainIds: ["eip155:1"], evidenceUrls: ["https://example.invalid/source"]
  };
  const unsigned: Omit<SignedAssetManifest, "signature"> = {
    schema: "localswap.signed-asset-manifest.v1", sourceId: source.id, revision: 3,
    issuedAt: "2026-08-31T00:00:00.000Z", expiresAt: "2026-09-30T00:00:00.000Z",
    assets: [asset], evidenceUrls: ["https://example.invalid/revision/3"], ...overrides
  };
  return { signer, source, unsigned, signed: { ...unsigned, signature: await signer.signMessage(canonicalSignedAssetManifestPayload(unsigned)) } };
}

describe("signed asset sources", () => {
  it("binds a manifest to the exact session-pinned source and canonical payload", async () => {
    const { source, signed } = await fixture();
    const verified = verifySignedAssetManifest(signed, source, { now });
    expect(verified.recoveredSigner).toBe(source.signerAddress);
    expect(verified.sourceFingerprint).toBe(assetSourceFingerprint(source));
    expect(verified.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(verified.manifest.assets[0].execution).toBe("design-gate");
  });

  it("rejects signer substitution, expiry, disallowed chains, and executable imports", async () => {
    const { source, signed } = await fixture();
    expect(() => verifySignedAssetManifest(signed, { ...source, signerAddress: Wallet.createRandom().address }, { now })).toThrow("SIGNED_MANIFEST_SIGNER_NOT_PINNED");
    expect(() => verifySignedAssetManifest(signed, source, { now: Date.parse("2026-10-01T00:00:00.000Z") })).toThrow("SIGNED_MANIFEST_EXPIRED");
    expect(() => verifySignedAssetManifest(signed, { ...source, allowedChainIds: ["eip155:8453"] }, { now })).toThrow("SIGNED_MANIFEST_CHAIN_NOT_ALLOWED");
    expect(() => verifySignedAssetManifest({ ...signed, assets: [{ ...asset, execution: "ready" }] }, source, { now })).toThrow("IMPORTED_ASSET_CANNOT_ENABLE_EXECUTION");
    expect(() => verifySignedAssetManifest({ ...signed, unsignedClaim: "not covered" }, source, { now })).toThrow("SIGNED_MANIFEST_UNKNOWN_FIELD");
    expect(() => verifySignedAssetManifest({ ...signed, assets: [{ ...asset, logoURI: "https://example.invalid/logo" }] }, source, { now })).toThrow("SIGNED_MANIFEST_ASSET_UNKNOWN_FIELD");
  });

  it("blocks rollback and same-revision equivocation while allowing an exact replay", async () => {
    const { signer, source, signed } = await fixture();
    const verified = verifySignedAssetManifest(signed, source, { now });
    const head = { revision: 3, payloadHash: verified.payloadHash };
    expect(verifySignedAssetManifest(signed, source, { now, previousHead: head }).payloadHash).toBe(head.payloadHash);
    const rollbackUnsigned = { ...signed, revision: 2 };
    const { signature: _oldSignature, ...rollbackPayload } = rollbackUnsigned;
    const rollback = { ...rollbackPayload, signature: await signer.signMessage(canonicalSignedAssetManifestPayload(rollbackPayload)) };
    expect(() => verifySignedAssetManifest(rollback, source, { now, previousHead: head })).toThrow("SIGNED_MANIFEST_ROLLBACK_BLOCKED");
    const changed = await fixture({ revision: 3, evidenceUrls: ["https://example.invalid/changed"] });
    expect(() => verifySignedAssetManifest(changed.signed, changed.source, { now, previousHead: head })).toThrow("SIGNED_MANIFEST_REVISION_CONFLICT");
  });

  it("reports exact metadata conflicts separately from symbol collisions", () => {
    const exact = { ...asset, name: "Impostor Dai" };
    const symbolOnly = { ...asset, assetType: "eip155:10/erc20:0x0000000000000000000000000000000000000001" };
    const findings = findAssetCollisions([exact, symbolOnly], [asset]);
    expect(findings.some((item) => item.kind === "metadata-conflict" && item.severity === "critical")).toBe(true);
    expect(findings.some((item) => item.kind === "symbol-collision" && item.severity === "warning")).toBe(true);
  });
});

describe("EVM signed metadata verification", () => {
  it("requires the exact chain, bytecode, and current metadata", async () => {
    const reader = {
      chainId: async () => 1n,
      getCode: async () => "0x6000",
      readMetadata: async () => ({ symbol: "DAI", name: "Dai Stablecoin", decimals: 18 })
    };
    await expect(verifyEvmAssetOnChain(asset, reader)).resolves.toMatchObject({ status: "verified" });
    await expect(verifyEvmAssetOnChain(asset, { ...reader, chainId: async () => 8453n })).resolves.toMatchObject({ status: "not-checked" });
    await expect(verifyEvmAssetOnChain(asset, { ...reader, getCode: async () => "0x" })).resolves.toMatchObject({ status: "mismatch" });
    await expect(verifyEvmAssetOnChain(asset, { ...reader, readMetadata: async () => ({ symbol: "DAI", name: "Dai Stablecoin", decimals: 6 }) })).resolves.toMatchObject({ status: "mismatch" });
    await expect(verifyEvmAssetOnChain(asset, { ...reader, chainId: async () => { throw new Error("offline"); } })).resolves.toMatchObject({ status: "not-checked" });
  });
});
