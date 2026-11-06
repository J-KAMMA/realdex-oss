import { Contract, JsonRpcProvider, getAddress, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { ERC20_ABI } from "../abi";
import { BUILT_IN_ASSETS, isCaip2, validateAssetManifest } from "./registry";
import type { UniversalAsset } from "./types";

const MAX_SOURCE_ASSETS = 10_000;
const MAX_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type AssetSourceDescriptor = {
  schema: "localswap.asset-source.v1";
  id: string;
  name: string;
  signerAddress: string;
  allowedChainIds: string[];
  evidenceUrls: string[];
};

export type SignedAssetManifest = {
  schema: "localswap.signed-asset-manifest.v1";
  sourceId: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  assets: UniversalAsset[];
  evidenceUrls: string[];
  signature: string;
};

export type AssetSourceHead = { revision: number; payloadHash: string };

export type AssetCollision = {
  severity: "info" | "warning" | "critical";
  kind: "same-metadata" | "metadata-conflict" | "symbol-collision";
  assetType: string;
  comparedAssetType: string;
  message: string;
};

export type VerifiedAssetManifest = {
  source: AssetSourceDescriptor;
  sourceFingerprint: string;
  manifest: SignedAssetManifest;
  payloadHash: string;
  recoveredSigner: string;
  collisions: AssetCollision[];
};

export type OnChainAssetCheck = {
  assetType: string;
  status: "verified" | "partial" | "mismatch" | "not-checked";
  message: string;
  observed?: { symbol?: string; name?: string; decimals: number; authority?: string };
};

export type EvmOnChainAssetCheck = OnChainAssetCheck;

export type EvmAssetMetadataReader = {
  chainId(): Promise<bigint>;
  getCode(address: string): Promise<string>;
  readMetadata(address: string): Promise<{ symbol: string; name: string; decimals: number }>;
};

export function validateAssetSourceDescriptor(value: unknown): AssetSourceDescriptor {
  if (!value || typeof value !== "object") throw new Error("ASSET_SOURCE_OBJECT_REQUIRED");
  assertExactKeys(value as Record<string, unknown>, ["schema", "id", "name", "signerAddress", "allowedChainIds", "evidenceUrls"], "ASSET_SOURCE_UNKNOWN_FIELD");
  const source = value as Partial<AssetSourceDescriptor>;
  if (source.schema !== "localswap.asset-source.v1") throw new Error("ASSET_SOURCE_SCHEMA_UNSUPPORTED");
  if (!source.id || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(source.id)) throw new Error("ASSET_SOURCE_ID_INVALID");
  if (!source.name || source.name.length > 100) throw new Error("ASSET_SOURCE_NAME_INVALID");
  let signerAddress: string;
  try { signerAddress = getAddress(source.signerAddress ?? ""); }
  catch { throw new Error("ASSET_SOURCE_SIGNER_INVALID"); }
  if (signerAddress === "0x0000000000000000000000000000000000000000") throw new Error("ASSET_SOURCE_SIGNER_INVALID");
  if (!Array.isArray(source.allowedChainIds) || source.allowedChainIds.length === 0 || source.allowedChainIds.length > 100) throw new Error("ASSET_SOURCE_CHAINS_INVALID");
  if (source.allowedChainIds.some((chainId) => !isCaip2(chainId)) || new Set(source.allowedChainIds).size !== source.allowedChainIds.length) throw new Error("ASSET_SOURCE_CHAINS_INVALID");
  if (!validEvidenceUrls(source.evidenceUrls)) throw new Error("ASSET_SOURCE_EVIDENCE_INVALID");
  return { ...source, signerAddress } as AssetSourceDescriptor;
}

export function assetSourceFingerprint(sourceValue: unknown): string {
  const source = validateAssetSourceDescriptor(sourceValue);
  return keccak256(toUtf8Bytes(JSON.stringify({
    schema: source.schema, id: source.id, name: source.name, signerAddress: source.signerAddress,
    allowedChainIds: source.allowedChainIds, evidenceUrls: source.evidenceUrls
  })));
}

export function canonicalSignedAssetManifestPayload(manifest: Omit<SignedAssetManifest, "signature">): string {
  return `LocalSwap signed asset manifest v1\n${JSON.stringify({
    schema: manifest.schema,
    sourceId: manifest.sourceId,
    revision: manifest.revision,
    issuedAt: manifest.issuedAt,
    expiresAt: manifest.expiresAt,
    assets: manifest.assets.map((asset) => ({
      assetType: asset.assetType, symbol: asset.symbol, name: asset.name, decimals: asset.decimals,
      provenance: asset.provenance, execution: asset.execution
    })),
    evidenceUrls: manifest.evidenceUrls
  })}`;
}

export function verifySignedAssetManifest(
  value: unknown,
  sourceValue: unknown,
  options: { now?: number; previousHead?: AssetSourceHead; existingAssets?: UniversalAsset[] } = {}
): VerifiedAssetManifest {
  const source = validateAssetSourceDescriptor(sourceValue);
  const manifest = validateSignedManifestShape(value);
  if (manifest.sourceId !== source.id) throw new Error("SIGNED_MANIFEST_SOURCE_MISMATCH");
  const now = options.now ?? Date.now();
  const issuedAt = parseCanonicalTimestamp(manifest.issuedAt, "SIGNED_MANIFEST_ISSUED_AT_INVALID");
  const expiresAt = parseCanonicalTimestamp(manifest.expiresAt, "SIGNED_MANIFEST_EXPIRES_AT_INVALID");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("SIGNED_MANIFEST_FROM_FUTURE");
  if (expiresAt <= now) throw new Error("SIGNED_MANIFEST_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) throw new Error("SIGNED_MANIFEST_VALIDITY_INVALID");
  for (const asset of manifest.assets) {
    const chainId = asset.assetType.slice(0, asset.assetType.indexOf("/"));
    if (!source.allowedChainIds.includes(chainId)) throw new Error("SIGNED_MANIFEST_CHAIN_NOT_ALLOWED");
  }
  const { signature: _signature, ...unsigned } = manifest;
  const payload = canonicalSignedAssetManifestPayload(unsigned);
  const payloadHash = keccak256(toUtf8Bytes(payload));
  let recoveredSigner: string;
  try { recoveredSigner = getAddress(verifyMessage(payload, manifest.signature)); }
  catch { throw new Error("SIGNED_MANIFEST_SIGNATURE_INVALID"); }
  if (recoveredSigner !== source.signerAddress) throw new Error("SIGNED_MANIFEST_SIGNER_NOT_PINNED");
  const previous = options.previousHead;
  if (previous && manifest.revision < previous.revision) throw new Error("SIGNED_MANIFEST_ROLLBACK_BLOCKED");
  if (previous && manifest.revision === previous.revision && payloadHash !== previous.payloadHash) throw new Error("SIGNED_MANIFEST_REVISION_CONFLICT");
  return {
    source,
    sourceFingerprint: assetSourceFingerprint(source),
    manifest,
    payloadHash,
    recoveredSigner,
    collisions: findAssetCollisions(manifest.assets, options.existingAssets ?? BUILT_IN_ASSETS)
  };
}

export function findAssetCollisions(incoming: UniversalAsset[], existing: UniversalAsset[]): AssetCollision[] {
  const findings: AssetCollision[] = [];
  for (const asset of incoming) {
    for (const known of existing) {
      if (asset.assetType === known.assetType) {
        const same = asset.symbol === known.symbol && asset.name === known.name && asset.decimals === known.decimals;
        findings.push({
          severity: same ? "info" : "critical", kind: same ? "same-metadata" : "metadata-conflict",
          assetType: asset.assetType, comparedAssetType: known.assetType,
          message: same ? "Exact CAIP-19 identity already exists with matching metadata." : "Exact CAIP-19 identity conflicts with existing metadata; it must not replace the known record."
        });
      } else if (asset.symbol.toLowerCase() === known.symbol.toLowerCase()) {
        findings.push({
          severity: "warning", kind: "symbol-collision", assetType: asset.assetType, comparedAssetType: known.assetType,
          message: "The same symbol refers to a different CAIP-19 identity. Symbol equality does not establish equivalence."
        });
      }
    }
  }
  return findings;
}

export async function verifyEvmAssetOnChain(asset: UniversalAsset, reader: EvmAssetMetadataReader): Promise<EvmOnChainAssetCheck> {
  const parsed = parseEvmAssetType(asset.assetType);
  if (!parsed) return { assetType: asset.assetType, status: "not-checked", message: "This verifier only handles EVM ERC-20 identities." };
  try {
    if (await reader.chainId() !== parsed.chainId) return { assetType: asset.assetType, status: "not-checked", message: "The configured RPC is for a different chain; metadata was not guessed." };
    const code = await reader.getCode(parsed.address);
    if (!code || code === "0x") return { assetType: asset.assetType, status: "mismatch", message: "No contract bytecode exists at the signed ERC-20 address." };
    const observed = await reader.readMetadata(parsed.address);
    const matches = observed.symbol === asset.symbol && observed.name === asset.name && observed.decimals === asset.decimals;
    return {
      assetType: asset.assetType,
      status: matches ? "verified" : "mismatch",
      message: matches ? "Contract bytecode and current symbol, name, and decimals match the signed record." : "Current on-chain metadata differs from the signed record.",
      observed
    };
  } catch {
    return { assetType: asset.assetType, status: "not-checked", message: "The configured RPC could not verify current ERC-20 metadata; nothing was inferred." };
  }
}

export function createEvmAssetMetadataReader(provider: JsonRpcProvider): EvmAssetMetadataReader {
  return {
    chainId: async () => (await provider.getNetwork()).chainId,
    getCode: (address) => provider.getCode(address),
    readMetadata: async (address) => {
      const token = new Contract(address, ERC20_ABI, provider);
      const [symbol, name, decimals] = await Promise.all([token.symbol(), token.name(), token.decimals()]);
      return { symbol: String(symbol), name: String(name), decimals: Number(decimals) };
    }
  };
}

function validateSignedManifestShape(value: unknown): SignedAssetManifest {
  if (!value || typeof value !== "object") throw new Error("SIGNED_MANIFEST_OBJECT_REQUIRED");
  assertExactKeys(value as Record<string, unknown>, ["schema", "sourceId", "revision", "issuedAt", "expiresAt", "assets", "evidenceUrls", "signature"], "SIGNED_MANIFEST_UNKNOWN_FIELD");
  const manifest = value as Partial<SignedAssetManifest>;
  if (manifest.schema !== "localswap.signed-asset-manifest.v1") throw new Error("SIGNED_MANIFEST_SCHEMA_UNSUPPORTED");
  if (!manifest.sourceId || !Number.isInteger(manifest.revision) || Number(manifest.revision) <= 0) throw new Error("SIGNED_MANIFEST_IDENTITY_INVALID");
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0 || manifest.assets.length > MAX_SOURCE_ASSETS) throw new Error("SIGNED_MANIFEST_SIZE_INVALID");
  if (!validEvidenceUrls(manifest.evidenceUrls)) throw new Error("SIGNED_MANIFEST_EVIDENCE_INVALID");
  if (!manifest.signature || !/^0x[0-9a-fA-F]{130}$/.test(manifest.signature)) throw new Error("SIGNED_MANIFEST_SIGNATURE_INVALID");
  for (const asset of manifest.assets) assertExactKeys(asset as unknown as Record<string, unknown>, ["assetType", "symbol", "name", "decimals", "provenance", "execution"], "SIGNED_MANIFEST_ASSET_UNKNOWN_FIELD");
  validateAssetManifest({ schema: "localswap.asset-manifest.v1", name: manifest.sourceId, revision: manifest.revision, assets: manifest.assets, evidenceUrls: manifest.evidenceUrls });
  return manifest as SignedAssetManifest;
}

function parseEvmAssetType(assetType: string): { chainId: bigint; address: string } | undefined {
  const match = /^eip155:([0-9]+)\/erc20:(0x[0-9a-fA-F]{40})$/.exec(assetType);
  if (!match) return undefined;
  try { return { chainId: BigInt(match[1]), address: getAddress(match[2]) }; }
  catch { return undefined; }
}

function parseCanonicalTimestamp(value: string, error: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(error);
  return parsed;
}

function validEvidenceUrls(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every((url) => {
    if (typeof url !== "string") return false;
    try { return new URL(url).protocol === "https:"; } catch { return false; }
  });
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[], error: string) {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error(error);
}
