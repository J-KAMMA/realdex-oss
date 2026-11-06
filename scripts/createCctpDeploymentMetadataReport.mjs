import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { base58 } from "@scure/base";
import { keccak256, toUtf8Bytes } from "ethers";

const REPOSITORY_URL = "https://github.com/circlefin/stablecoin-evm";
const DEPLOYMENT_COMMIT = "a1b5455f1779d8840b6b53cc562f5cc3d0a4875d";
// NOTE: this string is the source path Circle's own build embedded in the compiler
// metadata of the deployed testnet USDC contracts. It is public on-chain data of a
// third party, not a path of this project, and it cannot be rewritten: the metadata
// hash, source hashes and IPFS hash pinned below are computed over it.
const DEPLOYMENT_SOURCE_PREFIX = "/Users/quang.lam/Documents/GitHub/stablecoin-evm-private-usdc-cbase-testnet/";
const COMPILER_VERSION = "0.6.12+commit.27d51765";
const OPTIMIZER_RUNS = 10_000_000;
const ASSET_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const IMPLEMENTATION_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const SIGNATURE_CHECKER_ADDRESS = "0xba3b60c21e28c41df4babd90f228e1d368627da6";
const RPC_ENDPOINTS = ["https://sepolia.base.org/", "https://base-sepolia-rpc.publicnode.com/"];
const MAX_HEAD_DIVERGENCE = 12;
const MAX_RESPONSE_BYTES = 1_000_000;
const EXPECTED_OPENZEPPELIN_KECCAK = {
  "@openzeppelin/contracts/math/SafeMath.sol": "0xcc78a17dd88fa5a2edc60c8489e2f405c0913b377216a5b26b35656b2d0dab52",
  "@openzeppelin/contracts/token/ERC20/IERC20.sol": "0x5f02220344881ce43204ae4a6281145a67bc52c2bb1290a791857df3d19d78f5",
  "@openzeppelin/contracts/token/ERC20/SafeERC20.sol": "0xf12dfbe97e6276980b83d2830bb0eb75e0cf4f3e626c2471137f82158ae6a0fc",
  "@openzeppelin/contracts/utils/Address.sol": "0x28911e614500ae7c607a432a709d35da25f3bc5ddc8bd12b278b66358070c0ea"
};

const PROXY_SOURCES = [
  "contracts/v1/FiatTokenProxy.sol",
  "contracts/upgradeability/AdminUpgradeabilityProxy.sol",
  "contracts/upgradeability/Proxy.sol",
  "contracts/upgradeability/UpgradeabilityProxy.sol",
  "@openzeppelin/contracts/utils/Address.sol"
];
const SIGNATURE_CHECKER_SOURCES = [
  "contracts/interface/IERC1271.sol",
  "contracts/util/ECRecover.sol",
  "contracts/util/SignatureChecker.sol"
];
const IMPLEMENTATION_SOURCES = [
  "contracts/interface/IERC1271.sol", "contracts/util/ECRecover.sol", "contracts/util/EIP712.sol",
  "contracts/util/MessageHashUtils.sol", "contracts/util/SignatureChecker.sol",
  "contracts/v1.1/FiatTokenV1_1.sol", "contracts/v1.1/Rescuable.sol",
  "contracts/v1/AbstractFiatTokenV1.sol", "contracts/v1/Blacklistable.sol", "contracts/v1/FiatTokenV1.sol",
  "contracts/v1/Ownable.sol", "contracts/v1/Pausable.sol", "contracts/v2/AbstractFiatTokenV2.sol",
  "contracts/v2/EIP2612.sol", "contracts/v2/EIP3009.sol", "contracts/v2/EIP712Domain.sol",
  "contracts/v2/FiatTokenV2.sol", "contracts/v2/FiatTokenV2_1.sol", "contracts/v2/FiatTokenV2_2.sol",
  "@openzeppelin/contracts/math/SafeMath.sol", "@openzeppelin/contracts/token/ERC20/IERC20.sol",
  "@openzeppelin/contracts/token/ERC20/SafeERC20.sol", "@openzeppelin/contracts/utils/Address.sol"
];

if (process.argv.length === 3 && process.argv[2] === "--self-test") {
  runSelfTests();
  process.stdout.write("CCTP deployment metadata report self-tests passed\n");
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const repo = resolve(args.repo);
const outputPath = args.output ? resolve(args.output) : undefined;
assertOfficialRepository(repo);
const solc = createRequire(join(repo, "package.json"))("solc");
if (typeof solc.version !== "function" || String(solc.version()) !== `${COMPILER_VERSION}.Emscripten.clang`) fail("CCTP_METADATA_COMPILER_VERSION_INVALID");

const observed = await observeDeployment();
const proxy = compileTarget(repo, solc, PROXY_SOURCES, "contracts/v1/FiatTokenProxy.sol", "FiatTokenProxy", {});
const signatureChecker = compileTarget(repo, solc, SIGNATURE_CHECKER_SOURCES, "contracts/util/SignatureChecker.sol", "SignatureChecker", {});
signatureChecker.runtime = embedLibraryAddress(signatureChecker.runtime, observed.signatureCheckerAddress);
const implementation = compileTarget(repo, solc, IMPLEMENTATION_SOURCES, "contracts/v2/FiatTokenV2_2.sol", "FiatTokenV2_2", {});
implementation.runtime = linkSignatureChecker(implementation.runtime, implementation.linkReferences, observed.signatureCheckerAddress);
implementation.linkingProfile = "post-compilation-link";

const contracts = {
  proxy: contractReport(proxy, observed.proxyCode),
  implementation: contractReport(implementation, observed.implementationCode),
  signatureChecker: contractReport(signatureChecker, observed.signatureCheckerCode)
};
const fullMetadataContracts = Object.entries(contracts).filter(([, value]) => value.metadataMatched).map(([name]) => name);
const partialMetadataContracts = Object.entries(contracts).filter(([, value]) => !value.metadataMatched).map(([name]) => name);
const artifact = {
  schema: "realdex.cctp-deployment-metadata-report.v2",
  status: partialMetadataContracts.length ? "verified-mixed-runtime" : "verified-full-runtime",
  executionEnabled: false,
  signingEnabled: false,
  submissionEnabled: false,
  releaseEligible: false,
  explicitUserReleaseRequired: true,
  repository: {
    url: REPOSITORY_URL,
    currentHead: git(repo, ["rev-parse", "HEAD"]).trim().toLowerCase(),
    deploymentCommit: DEPLOYMENT_COMMIT,
    cleanTrackedTree: true
  },
  compiler: { version: COMPILER_VERSION, reportedVersion: String(solc.version()), optimizerEnabled: true, optimizerRuns: OPTIMIZER_RUNS, evmVersion: "istanbul" },
  deploymentSourcePrefix: DEPLOYMENT_SOURCE_PREFIX,
  network: { caip2: "eip155:84532", chainId: "84532", readerIds: observed.readers.map((reader) => reader.id), minimumObservedBlock: Math.min(...observed.readers.map((reader) => reader.blockNumber)), maximumHeadDivergence: MAX_HEAD_DIVERGENCE },
  asset: { caip19: `eip155:84532/erc20:${ASSET_ADDRESS}`, proxyAddress: ASSET_ADDRESS, implementationSlot: IMPLEMENTATION_SLOT, implementationAddress: observed.implementationAddress, signatureCheckerAddress: observed.signatureCheckerAddress },
  contracts,
  fullMetadataContracts,
  partialMetadataContracts,
  metadataVerified: partialMetadataContracts.length === 0,
  observedAt: new Date().toISOString()
};
const serialized = `${canonicalStringify(artifact)}\n`;
const artifactSha256 = `sha256:${sha256(serialized)}`;
if (outputPath) writeFileSync(outputPath, serialized, { encoding: "utf8", flag: "wx" });
else process.stdout.write(serialized);
process.stderr.write(`deploymentMetadataReportSha256=${artifactSha256}\n`);

function parseArgs(values) {
  const result = {};
  if (values.length % 2 !== 0) usage();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index], value = values[index + 1];
    if ((key !== "--repo" && key !== "--output") || !value || value.startsWith("--")) usage();
    result[key.slice(2)] = value;
  }
  if (!result.repo || Object.keys(result).some((key) => key !== "repo" && key !== "output")) usage();
  return result;
}

function usage() { fail("Usage: node scripts/createCctpDeploymentMetadataReport.mjs --repo <official-clone-with-history> [--output <new-file>]"); }

function assertOfficialRepository(repoPath) {
  const origin = git(repoPath, ["remote", "get-url", "origin"]).trim().replace(/^git\+/, "").replace(/\.git$/, "");
  if (origin !== REPOSITORY_URL) fail("CCTP_METADATA_REPOSITORY_ORIGIN_INVALID");
  if (git(repoPath, ["status", "--porcelain", "--untracked-files=no"]).trim()) fail("CCTP_METADATA_REPOSITORY_DIRTY");
  try { git(repoPath, ["cat-file", "-e", `${DEPLOYMENT_COMMIT}^{commit}`]); }
  catch { fail("CCTP_METADATA_DEPLOYMENT_COMMIT_MISSING"); }
}

function compileTarget(repoPath, compiler, sourcePaths, targetPath, contractName, libraries) {
  const sources = {};
  const sourceHashes = {};
  for (const path of sourcePaths) {
    const sourceName = path.startsWith("@openzeppelin/") ? path : `${DEPLOYMENT_SOURCE_PREFIX}${path}`;
    const content = path.startsWith("@openzeppelin/")
      ? readFileSync(join(repoPath, "node_modules", path), "utf8")
      : git(repoPath, ["show", `${DEPLOYMENT_COMMIT}:${path}`]);
    sources[sourceName] = { content };
    const sourceHash = keccak256(toUtf8Bytes(content));
    if (path.startsWith("@openzeppelin/") && EXPECTED_OPENZEPPELIN_KECCAK[path] !== sourceHash) fail("CCTP_METADATA_OPENZEPPELIN_SOURCE_MISMATCH");
    sourceHashes[sourceName] = sourceHash;
  }
  const target = `${DEPLOYMENT_SOURCE_PREFIX}${targetPath}`;
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: OPTIMIZER_RUNS }, evmVersion: "istanbul", metadata: { bytecodeHash: "ipfs" },
      libraries, remappings: [], outputSelection: { "*": { "*": ["evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "metadata"] } }
    }
  };
  const output = JSON.parse(compiler.compile(JSON.stringify(input)));
  const errors = Array.isArray(output.errors) ? output.errors.filter((item) => item.severity === "error") : [];
  if (errors.length) fail(`CCTP_METADATA_COMPILE_FAILED:${errors.map((item) => item.formattedMessage ?? item.message).join("\n")}`);
  const item = output.contracts?.[target]?.[contractName];
  if (!item?.evm?.deployedBytecode?.object || typeof item.metadata !== "string") fail("CCTP_METADATA_CONTRACT_OUTPUT_MISSING");
  return {
    sourcePath: target,
    sourceCount: sourcePaths.length,
    sourceSetSha256: `sha256:${sha256(canonicalStringify(sourceHashes))}`,
    sourceHashes,
    runtime: `0x${item.evm.deployedBytecode.object}`,
    linkReferences: item.evm.deployedBytecode.linkReferences,
    metadataJson: item.metadata,
    metadataJsonSha256: `sha256:${sha256(item.metadata)}`
  };
}

function contractReport(compiled, observedRuntime) {
  const compiledParts = splitRuntimeMetadata(compiled.runtime);
  const observedParts = splitRuntimeMetadata(observedRuntime);
  if (compiledParts.logic !== observedParts.logic) fail("CCTP_METADATA_RUNTIME_LOGIC_MISMATCH");
  const metadataMatched = compiled.runtime === observedRuntime;
  return {
    verificationMode: metadataMatched ? "full-runtime" : "partial-runtime",
    metadataMatched,
    sourcePath: compiled.sourcePath,
    sourceCount: compiled.sourceCount,
    sourceSetSha256: compiled.sourceSetSha256,
    sourceHashes: compiled.sourceHashes,
    metadataJsonSha256: compiled.metadataJsonSha256,
    metadataJson: compiled.metadataJson,
    linkingProfile: compiled.linkingProfile ?? "no-external-library-link",
    linkReferences: compiled.linkReferences,
    logicRuntimeKeccak256: keccak256(compiledParts.logic),
    compiledFullRuntimeKeccak256: keccak256(compiled.runtime),
    observedFullRuntimeKeccak256: keccak256(observedRuntime),
    observedRuntimeBytes: (observedRuntime.length - 2) / 2,
    compiledMetadata: compiledParts.metadata,
    observedMetadata: observedParts.metadata
  };
}

function splitRuntimeMetadata(runtime) {
  const value = hexData(runtime);
  if (value.length < 108 || value.slice(-4) !== "0033") fail("CCTP_METADATA_CBOR_LENGTH_INVALID");
  const metadataBytes = Number.parseInt(value.slice(-4), 16);
  const start = value.length - 4 - metadataBytes * 2;
  if (metadataBytes !== 51 || start <= 2) fail("CCTP_METADATA_CBOR_LENGTH_INVALID");
  const cborHex = `0x${value.slice(start, -4)}`;
  const match = /^0xa2646970667358221220([0-9a-f]{64})64736f6c634300060c$/.exec(cborHex);
  if (!match) fail("CCTP_METADATA_CBOR_INVALID");
  const digest = match[1];
  return {
    logic: value.slice(0, start),
    metadata: { cborHex, lengthBytes: metadataBytes, ipfsCidV0: base58.encode(Uint8Array.from(`1220${digest}`.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))), ipfsMultihashSha256: `sha256:${digest}`, solcVersion: "0.6.12" }
  };
}

async function observeDeployment() {
  const readers = await Promise.all(RPC_ENDPOINTS.map(async (endpoint) => {
    const id = new URL(endpoint).hostname.toLowerCase();
    const chainId = BigInt(await rpc(endpoint, "eth_chainId", []));
    if (chainId !== 84_532n) fail("CCTP_METADATA_RPC_CHAIN_MISMATCH");
    const blockNumber = safeHexNumber(await rpc(endpoint, "eth_blockNumber", []));
    const proxyCode = hexData(await rpc(endpoint, "eth_getCode", [ASSET_ADDRESS, "latest"]));
    const implementationWord = hexData(await rpc(endpoint, "eth_getStorageAt", [ASSET_ADDRESS, IMPLEMENTATION_SLOT, "latest"]));
    if (!/^0x0{24}[0-9a-f]{40}$/.test(implementationWord)) fail("CCTP_METADATA_IMPLEMENTATION_SLOT_INVALID");
    const implementationAddress = `0x${implementationWord.slice(-40)}`;
    const implementationCode = hexData(await rpc(endpoint, "eth_getCode", [implementationAddress, "latest"]));
    const signatureCheckerAddress = SIGNATURE_CHECKER_ADDRESS;
    const signatureCheckerCode = hexData(await rpc(endpoint, "eth_getCode", [signatureCheckerAddress, "latest"]));
    if (proxyCode === "0x" || implementationCode === "0x" || signatureCheckerCode === "0x") fail("CCTP_METADATA_RUNTIME_MISSING");
    return { id, endpoint, blockNumber, proxyCode, implementationAddress, implementationCode, signatureCheckerAddress, signatureCheckerCode };
  }));
  if (Math.max(...readers.map((item) => item.blockNumber)) - Math.min(...readers.map((item) => item.blockNumber)) > MAX_HEAD_DIVERGENCE) fail("CCTP_METADATA_RPC_HEAD_DIVERGED");
  const identities = readers.map((item) => `${item.proxyCode}:${item.implementationAddress}:${item.implementationCode}:${item.signatureCheckerAddress}:${item.signatureCheckerCode}`);
  if (new Set(identities).size !== 1) fail("CCTP_METADATA_RPC_IDENTITY_DIVERGED");
  return { readers, proxyCode: readers[0].proxyCode, implementationAddress: readers[0].implementationAddress, implementationCode: readers[0].implementationCode, signatureCheckerAddress: readers[0].signatureCheckerAddress, signatureCheckerCode: readers[0].signatureCheckerCode };
}

function embedLibraryAddress(runtime, address) { return `${runtime.slice(0, 4)}${address.slice(2)}${runtime.slice(44)}`; }

function linkSignatureChecker(runtime, references, address) {
  const invalid = () => fail("CCTP_METADATA_LINK_REFERENCE_INVALID");
  const path = `${DEPLOYMENT_SOURCE_PREFIX}contracts/util/SignatureChecker.sol`;
  if (typeof runtime !== "string" || !runtime.startsWith("0x") || runtime.length % 2 !== 0 || !/^0x[0-9a-f]{40}$/.test(address) || /^0x0{40}$/.test(address)) invalid();
  if (!references || Object.keys(references).length !== 1 || !Object.hasOwn(references, path)) invalid();
  const libraries = references[path];
  if (!libraries || Object.keys(libraries).length !== 1 || !Array.isArray(libraries.SignatureChecker) || !libraries.SignatureChecker.length) invalid();
  const metadataBytes = Number.parseInt(runtime.slice(-4), 16);
  if (metadataBytes !== 51) invalid();
  const metadataStart = (runtime.length - 2) / 2 - metadataBytes - 2;
  const placeholder = `__$${keccak256(toUtf8Bytes(`${path}:SignatureChecker`)).slice(2, 36)}$__`;
  let linked = runtime, previousEnd = 0;
  for (const position of [...libraries.SignatureChecker].sort((left, right) => left.start - right.start)) {
    if (!position || Object.keys(position).length !== 2 || !Number.isSafeInteger(position.start) || position.length !== 20 || position.start < 1 || position.start < previousEnd || position.start + 20 > metadataStart) invalid();
    const start = 2 + position.start * 2;
    if (runtime.slice(start - 2, start) !== "73" || runtime.slice(start, start + 40) !== placeholder) invalid();
    linked = linked.slice(0, start) + address.slice(2) + linked.slice(start + 40);
    previousEnd = position.start + 20;
  }
  if (!/^0x(?:[0-9a-f]{2})+$/.test(linked)) invalid();
  return linked;
}

async function rpc(endpoint, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
    if (!response.ok) fail("CCTP_METADATA_RPC_HTTP_FAILED");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) fail("CCTP_METADATA_RPC_RESPONSE_TOO_LARGE");
    const payload = JSON.parse(text);
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== 1 || payload.error !== undefined || !("result" in payload)) fail("CCTP_METADATA_RPC_RESPONSE_INVALID");
    return payload.result;
  } catch (reason) {
    if (reason?.name === "AbortError") fail("CCTP_METADATA_RPC_TIMEOUT");
    throw reason;
  } finally { clearTimeout(timeout); }
}

function runSelfTests() {
  const proxyMetadata = "a26469706673582212206f0bb189a04c9e932c2fc652002537537a56c29703f60e541f9d2fffcf6f1e1764736f6c634300060c0033";
  const parsed = splitRuntimeMetadata(`0x6000${proxyMetadata}`);
  if (parsed.logic !== "0x6000" || parsed.metadata.ipfsCidV0 !== "QmVp8Jgv5NKUoSC1TXhRMmEi9jiUvqGupW7iDmaCr9mBeE" || parsed.metadata.solcVersion !== "0.6.12") fail("SELF_TEST_METADATA_PARSE_FAILED");
  assertThrows(() => splitRuntimeMetadata(`0x6000${proxyMetadata.slice(0, -6)}00060d0033`), "CCTP_METADATA_CBOR_INVALID");
  assertThrows(() => splitRuntimeMetadata("0x6000"), "CCTP_METADATA_CBOR_LENGTH_INVALID");
  if (canonicalStringify({ z: 1, a: { y: 2 } }) !== '{"a":{"y":2},"z":1}') fail("SELF_TEST_CANONICAL_JSON_FAILED");
  if (Object.keys(EXPECTED_OPENZEPPELIN_KECCAK).length !== 4 || !Object.values(EXPECTED_OPENZEPPELIN_KECCAK).every((value) => /^0x[0-9a-f]{64}$/.test(value))) fail("SELF_TEST_SOURCE_PIN_INVALID");
  const path = `${DEPLOYMENT_SOURCE_PREFIX}contracts/util/SignatureChecker.sol`;
  const placeholder = `__$${keccak256(toUtf8Bytes(`${path}:SignatureChecker`)).slice(2, 36)}$__`;
  const unlinked = `0x73${placeholder}0073${placeholder}00${proxyMetadata}`;
  const references = { [path]: { SignatureChecker: [{ start: 1, length: 20 }, { start: 23, length: 20 }] } };
  const linked = linkSignatureChecker(unlinked, references, SIGNATURE_CHECKER_ADDRESS);
  if (linked !== `0x73${SIGNATURE_CHECKER_ADDRESS.slice(2)}0073${SIGNATURE_CHECKER_ADDRESS.slice(2)}00${proxyMetadata}`) fail("SELF_TEST_LINK_FAILED");
  for (const refs of [{}, { unexpected: references[path] }, { [path]: { SignatureChecker: [] } },
    { [path]: { SignatureChecker: [{ start: 1, length: 20 }, { start: 1, length: 20 }] } },
    { [path]: { SignatureChecker: [{ start: 1, length: 20 }] } },
    { [path]: { SignatureChecker: [{ start: 46, length: 20 }] } }]) {
    assertThrows(() => linkSignatureChecker(unlinked, refs, SIGNATURE_CHECKER_ADDRESS), "CCTP_METADATA_LINK_REFERENCE_INVALID");
  }
  assertThrows(() => linkSignatureChecker(unlinked.replace("0x73", "0x72"), references, SIGNATURE_CHECKER_ADDRESS), "CCTP_METADATA_LINK_REFERENCE_INVALID");
  assertThrows(() => linkSignatureChecker(unlinked, references, `0x${"0".repeat(40)}`), "CCTP_METADATA_LINK_REFERENCE_INVALID");
}

function assertThrows(action, message) { try { action(); } catch (reason) { if (reason instanceof Error && reason.message === message) return; throw reason; } fail(`SELF_TEST_EXPECTED_FAILURE_MISSING:${message}`); }
function git(cwd, args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 20_000_000 }); }
function safeHexNumber(value) { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) fail("CCTP_METADATA_RPC_QUANTITY_INVALID"); const parsed = BigInt(value); if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail("CCTP_METADATA_RPC_QUANTITY_INVALID"); return Number(parsed); }
function hexData(value) { if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) fail("CCTP_METADATA_HEX_DATA_INVALID"); return value.toLowerCase(); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalStringify(value) { return JSON.stringify(canonical(value)); }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])); return value; }
function fail(message) { throw new Error(message); }
