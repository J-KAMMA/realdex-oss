import { getAddress, sha256, toUtf8Bytes } from "ethers";
import { BASE_SEPOLIA_CCTP_ASSET } from "./cctp-asset-release";

const SHA_256 = /^sha256:[0-9a-f]{64}$/;
const HEX_32 = /^0x[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/;
const REPOSITORY_URL = "https://github.com/circlefin/stablecoin-evm";
const COMPILER_VERSION = "0.6.12+commit.27d51765";
const REPORTED_COMPILER_VERSION = "0.6.12+commit.27d51765.Emscripten.clang";
const READER_IDS = ["sepolia.base.org", "base-sepolia-rpc.publicnode.com"] as const;

export type CctpVerifiedContractEvidence = {
  compiledFullRuntimeKeccak256: string;
  logicRuntimeKeccak256: string;
  metadataMatched: false;
  metadataSha256: string;
  observedFullRuntimeKeccak256: string;
  observedRuntimeBytes: number;
  sourcePath: string;
  sourceSha256: string;
};

export type CctpSourceBytecodeVerificationArtifact = {
  asset: {
    caip19: string;
    implementationAddress: string;
    implementationSlot: string;
    proxyAddress: string;
    signatureCheckerAddress: string;
  };
  compiler: {
    optimizerEnabled: true;
    optimizerRuns: 10_000_000;
    reportedVersion: typeof REPORTED_COMPILER_VERSION;
    version: typeof COMPILER_VERSION;
  };
  contracts: {
    implementation: CctpVerifiedContractEvidence;
    proxy: CctpVerifiedContractEvidence;
    signatureChecker: CctpVerifiedContractEvidence;
  };
  executionEnabled: false;
  explicitUserReleaseRequired: true;
  metadataVerified: false;
  network: {
    caip2: "eip155:84532";
    chainId: "84532";
    maximumHeadDivergence: 12;
    minimumObservedBlock: number;
    readerIds: [typeof READER_IDS[0], typeof READER_IDS[1]];
  };
  observedAt: string;
  repository: { cleanTrackedTree: true; commitSha: string; url: typeof REPOSITORY_URL };
  schema: "realdex.cctp-source-bytecode-verification.v1";
  signingEnabled: false;
  sourceTreeSha256: string;
  status: "verified-partial-runtime";
  submissionEnabled: false;
  verificationMode: "partial-runtime";
};

export function validateCctpSourceBytecodeVerificationArtifact(value: unknown): CctpSourceBytecodeVerificationArtifact {
  const artifact = strictObject(value, ["asset", "compiler", "contracts", "executionEnabled", "explicitUserReleaseRequired", "metadataVerified", "network", "observedAt", "repository", "schema", "signingEnabled", "sourceTreeSha256", "status", "submissionEnabled", "verificationMode"]);
  if (artifact.schema !== "realdex.cctp-source-bytecode-verification.v1"
    || artifact.status !== "verified-partial-runtime"
    || artifact.verificationMode !== "partial-runtime"
    || artifact.executionEnabled !== false || artifact.signingEnabled !== false || artifact.submissionEnabled !== false
    || artifact.explicitUserReleaseRequired !== true || artifact.metadataVerified !== false
    || typeof artifact.sourceTreeSha256 !== "string" || !SHA_256.test(artifact.sourceTreeSha256)
    || typeof artifact.observedAt !== "string" || !canonicalTimestamp(artifact.observedAt)) invalid();

  const repository = strictObject(artifact.repository, ["cleanTrackedTree", "commitSha", "url"]);
  if (repository.url !== REPOSITORY_URL || repository.cleanTrackedTree !== true || typeof repository.commitSha !== "string" || !COMMIT_SHA.test(repository.commitSha)) invalid();

  const compiler = strictObject(artifact.compiler, ["optimizerEnabled", "optimizerRuns", "reportedVersion", "version"]);
  if (compiler.version !== COMPILER_VERSION || compiler.reportedVersion !== REPORTED_COMPILER_VERSION || compiler.optimizerEnabled !== true || compiler.optimizerRuns !== 10_000_000) invalid();

  const network = strictObject(artifact.network, ["caip2", "chainId", "maximumHeadDivergence", "minimumObservedBlock", "readerIds"]);
  if (network.caip2 !== BASE_SEPOLIA_CCTP_ASSET.caip2 || network.chainId !== BASE_SEPOLIA_CCTP_ASSET.chainId.toString() || network.maximumHeadDivergence !== 12 || !Number.isSafeInteger(network.minimumObservedBlock) || Number(network.minimumObservedBlock) < 0 || !Array.isArray(network.readerIds) || network.readerIds.length !== 2 || network.readerIds[0] !== READER_IDS[0] || network.readerIds[1] !== READER_IDS[1]) invalid();

  const asset = strictObject(artifact.asset, ["caip19", "implementationAddress", "implementationSlot", "proxyAddress", "signatureCheckerAddress"]);
  const assetId = `${BASE_SEPOLIA_CCTP_ASSET.caip2}/erc20:${BASE_SEPOLIA_CCTP_ASSET.address}`;
  if (asset.caip19 !== assetId || asset.proxyAddress !== BASE_SEPOLIA_CCTP_ASSET.address || asset.implementationSlot !== BASE_SEPOLIA_CCTP_ASSET.implementationSlot || !canonicalLowerAddress(asset.implementationAddress) || !canonicalLowerAddress(asset.signatureCheckerAddress)) invalid();

  const contracts = strictObject(artifact.contracts, ["implementation", "proxy", "signatureChecker"]);
  validateContractEvidence(contracts.proxy, "contracts/v1/FiatTokenProxy.sol");
  validateContractEvidence(contracts.implementation, "contracts/v2/FiatTokenV2_2.sol");
  validateContractEvidence(contracts.signatureChecker, "contracts/util/SignatureChecker.sol");
  return value as CctpSourceBytecodeVerificationArtifact;
}

export function cctpSourceBytecodeVerificationArtifactSha256(value: unknown): string {
  const artifact = validateCctpSourceBytecodeVerificationArtifact(value);
  return `sha256:${sha256(toUtf8Bytes(`${canonicalStringify(artifact)}\n`)).slice(2)}`;
}

function validateContractEvidence(value: unknown, sourcePath: string): void {
  const evidence = strictObject(value, ["compiledFullRuntimeKeccak256", "logicRuntimeKeccak256", "metadataMatched", "metadataSha256", "observedFullRuntimeKeccak256", "observedRuntimeBytes", "sourcePath", "sourceSha256"]);
  if (evidence.sourcePath !== sourcePath || evidence.metadataMatched !== false
    || typeof evidence.sourceSha256 !== "string" || !SHA_256.test(evidence.sourceSha256)
    || typeof evidence.metadataSha256 !== "string" || !SHA_256.test(evidence.metadataSha256)
    || typeof evidence.compiledFullRuntimeKeccak256 !== "string" || !HEX_32.test(evidence.compiledFullRuntimeKeccak256)
    || typeof evidence.observedFullRuntimeKeccak256 !== "string" || !HEX_32.test(evidence.observedFullRuntimeKeccak256)
    || typeof evidence.logicRuntimeKeccak256 !== "string" || !HEX_32.test(evidence.logicRuntimeKeccak256)
    || evidence.compiledFullRuntimeKeccak256 === evidence.observedFullRuntimeKeccak256
    || !Number.isSafeInteger(evidence.observedRuntimeBytes) || Number(evidence.observedRuntimeBytes) <= 0) invalid();
}

function canonicalLowerAddress(value: unknown): value is string {
  if (typeof value !== "string" || !LOWER_ADDRESS.test(value) || value === "0x0000000000000000000000000000000000000000") return false;
  try { return getAddress(value).toLowerCase() === value; } catch { return false; }
}

function canonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalStringify(item)}`).join(",")}}`;
  return JSON.stringify(value) as string;
}

function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) invalid();
  return object;
}

function invalid(): never { throw new Error("CCTP_SOURCE_BYTECODE_ARTIFACT_INVALID"); }
