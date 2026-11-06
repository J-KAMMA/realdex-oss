import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, relative, join, sep } from "node:path";
import { keccak256 } from "ethers";

const REPOSITORY_URL = "https://github.com/circlefin/stablecoin-evm";
const COMPILER_VERSION = "0.6.12+commit.27d51765";
const OPTIMIZER_RUNS = 10_000_000;
const CHAIN_ID = 84_532n;
const ASSET_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const IMPLEMENTATION_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const RPC_ENDPOINTS = ["https://sepolia.base.org/", "https://base-sepolia-rpc.publicnode.com/"];
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_HEAD_DIVERGENCE = 12;
const PROXY_TARGET = ["contracts/v1/FiatTokenProxy.sol", "FiatTokenProxy"];
const IMPLEMENTATION_TARGET = ["contracts/v2/FiatTokenV2_2.sol", "FiatTokenV2_2"];
const SIGNATURE_CHECKER_TARGET = ["contracts/util/SignatureChecker.sol", "SignatureChecker"];

if (process.argv.length === 3 && process.argv[2] === "--self-test") {
  runSelfTests();
  process.stdout.write("CCTP artifact generator self-tests passed\n");
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const repo = resolve(args.repo);
const outputPath = args.output ? resolve(args.output) : undefined;
const commitSha = git(repo, ["rev-parse", "HEAD"]).trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(commitSha)) fail("CCTP_ARTIFACT_REPOSITORY_COMMIT_INVALID");
const origin = git(repo, ["remote", "get-url", "origin"]).trim().replace(/^git\+/, "").replace(/\.git$/, "");
if (origin !== REPOSITORY_URL) fail("CCTP_ARTIFACT_REPOSITORY_ORIGIN_INVALID");
if (git(repo, ["status", "--porcelain", "--untracked-files=no"]).trim()) fail("CCTP_ARTIFACT_REPOSITORY_DIRTY");

const requireFromRepo = createRequire(join(repo, "package.json"));
const solc = requireFromRepo("solc");
assertCompilerVersion(solc);

const sources = loadSources(repo);
const sourceTreeSha256 = sha256(canonicalStringify(Object.fromEntries(Object.entries(sources).map(([name, item]) => [name, sha256(item.content)]))));
const compilerInput = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: OPTIMIZER_RUNS },
    outputSelection: { "*": { "*": ["evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "metadata"] } }
  }
};
const compiled = JSON.parse(solc.compile(JSON.stringify(compilerInput)));
const fatalErrors = Array.isArray(compiled.errors) ? compiled.errors.filter((item) => item.severity === "error") : [];
if (fatalErrors.length) fail(`CCTP_ARTIFACT_COMPILE_FAILED:${fatalErrors.map((item) => item.formattedMessage ?? item.message).join("\n")}`);

const proxyArtifact = contractArtifact(compiled, ...PROXY_TARGET);
const implementationArtifact = contractArtifact(compiled, ...IMPLEMENTATION_TARGET);
const signatureCheckerArtifact = contractArtifact(compiled, ...SIGNATURE_CHECKER_TARGET);
const observed = await observeChain();
const linkedImplementation = linkRuntime(implementationArtifact, observed.implementationCode);
const signatureCheckerAddress = linkedImplementation.libraryAddresses.SignatureChecker;
if (!signatureCheckerAddress) fail("CCTP_ARTIFACT_SIGNATURE_CHECKER_LINK_MISSING");
const signatureCheckerCode = await readCodeQuorum(signatureCheckerAddress, observed.readers);
const linkedSignatureChecker = embedLibraryAddress(signatureCheckerArtifact.runtime, signatureCheckerAddress);

const proxyComparison = comparePartialRuntime(proxyArtifact.runtime, observed.proxyCode, "CCTP_ARTIFACT_PROXY_RUNTIME_MISMATCH");
const implementationComparison = comparePartialRuntime(linkedImplementation.runtime, observed.implementationCode, "CCTP_ARTIFACT_IMPLEMENTATION_RUNTIME_MISMATCH");
const signatureCheckerComparison = comparePartialRuntime(linkedSignatureChecker, signatureCheckerCode, "CCTP_ARTIFACT_SIGNATURE_CHECKER_RUNTIME_MISMATCH");

const artifact = {
  schema: "realdex.cctp-source-bytecode-verification.v1",
  status: "verified-partial-runtime",
  executionEnabled: false,
  signingEnabled: false,
  submissionEnabled: false,
  explicitUserReleaseRequired: true,
  repository: { url: REPOSITORY_URL, commitSha, cleanTrackedTree: true },
  compiler: { version: COMPILER_VERSION, reportedVersion: String(solc.version()), optimizerEnabled: true, optimizerRuns: OPTIMIZER_RUNS },
  sourceTreeSha256: prefixedSha256(sourceTreeSha256),
  network: { caip2: "eip155:84532", chainId: CHAIN_ID.toString(), readerIds: observed.readers.map((reader) => reader.id), minimumObservedBlock: Math.min(...observed.readers.map((reader) => reader.blockNumber)), maximumHeadDivergence: MAX_HEAD_DIVERGENCE },
  asset: { caip19: `eip155:84532/erc20:${ASSET_ADDRESS}`, proxyAddress: ASSET_ADDRESS, implementationSlot: IMPLEMENTATION_SLOT, implementationAddress: observed.implementationAddress, signatureCheckerAddress },
  contracts: {
    proxy: contractEvidence(PROXY_TARGET[0], sources, proxyArtifact, observed.proxyCode, proxyComparison),
    implementation: contractEvidence(IMPLEMENTATION_TARGET[0], sources, implementationArtifact, observed.implementationCode, implementationComparison),
    signatureChecker: contractEvidence(SIGNATURE_CHECKER_TARGET[0], sources, signatureCheckerArtifact, signatureCheckerCode, signatureCheckerComparison)
  },
  verificationMode: "partial-runtime",
  metadataVerified: false,
  observedAt: new Date().toISOString()
};
const serialized = `${canonicalStringify(artifact)}\n`;
const artifactSha256 = `sha256:${sha256(serialized)}`;
if (outputPath) writeFileSync(outputPath, serialized, { encoding: "utf8", flag: "wx" });
else process.stdout.write(serialized);
process.stderr.write(`verificationArtifactSha256=${artifactSha256}\n`);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if ((key !== "--repo" && key !== "--output") || !value || value.startsWith("--")) fail("Usage: node scripts/createCctpAssetVerificationArtifact.mjs --repo <official-clone> [--output <new-file>]");
    result[key.slice(2)] = value;
  }
  if (!result.repo || Object.keys(result).some((key) => key !== "repo" && key !== "output")) fail("Usage: node scripts/createCctpAssetVerificationArtifact.mjs --repo <official-clone> [--output <new-file>]");
  return result;
}

function git(cwd, commandArgs) { return execFileSync("git", ["-C", cwd, ...commandArgs], { encoding: "utf8", windowsHide: true }); }

function loadSources(repoPath) {
  const result = {};
  for (const file of walkSolidity(join(repoPath, "contracts"))) result[toPosix(relative(repoPath, file))] = { content: readFileSync(file, "utf8") };
  const openzeppelinRoot = join(repoPath, "node_modules", "@openzeppelin", "contracts");
  if (!statSync(openzeppelinRoot).isDirectory()) fail("CCTP_ARTIFACT_OPENZEPPELIN_SOURCE_MISSING");
  for (const file of walkSolidity(openzeppelinRoot)) result[`@openzeppelin/contracts/${toPosix(relative(openzeppelinRoot, file))}`] = { content: readFileSync(file, "utf8") };
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function walkSolidity(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkSolidity(path) : entry.isFile() && entry.name.endsWith(".sol") ? [path] : [];
  });
}

function contractArtifact(output, sourcePath, contractName) {
  const item = output.contracts?.[sourcePath]?.[contractName];
  const runtime = item?.evm?.deployedBytecode?.object;
  if (!item || typeof runtime !== "string" || !runtime) fail(`CCTP_ARTIFACT_CONTRACT_OUTPUT_MISSING:${sourcePath}:${contractName}`);
  return { runtime: `0x${runtime}`, linkReferences: item.evm.deployedBytecode.linkReferences ?? {}, metadata: item.metadata };
}

async function observeChain() {
  const readers = await Promise.all(RPC_ENDPOINTS.map(async (endpoint) => {
    const id = new URL(endpoint).hostname.toLowerCase();
    const chainId = BigInt(await rpc(endpoint, "eth_chainId", []));
    if (chainId !== CHAIN_ID) fail("CCTP_ARTIFACT_RPC_CHAIN_MISMATCH");
    const blockNumber = safeHexNumber(await rpc(endpoint, "eth_blockNumber", []));
    const proxyCode = hexData(await rpc(endpoint, "eth_getCode", [ASSET_ADDRESS, "latest"]));
    const implementationWord = hexData(await rpc(endpoint, "eth_getStorageAt", [ASSET_ADDRESS, IMPLEMENTATION_SLOT, "latest"]));
    if (!/^0x0{24}[0-9a-f]{40}$/.test(implementationWord)) fail("CCTP_ARTIFACT_IMPLEMENTATION_SLOT_INVALID");
    const implementationAddress = `0x${implementationWord.slice(-40)}`;
    const implementationCode = hexData(await rpc(endpoint, "eth_getCode", [implementationAddress, "latest"]));
    if (proxyCode === "0x" || implementationCode === "0x") fail("CCTP_ARTIFACT_RUNTIME_MISSING");
    return { id, endpoint, blockNumber, proxyCode, implementationAddress, implementationCode };
  }));
  if (Math.max(...readers.map((reader) => reader.blockNumber)) - Math.min(...readers.map((reader) => reader.blockNumber)) > MAX_HEAD_DIVERGENCE) fail("CCTP_ARTIFACT_RPC_HEAD_DIVERGED");
  const identities = readers.map((reader) => `${reader.proxyCode}:${reader.implementationAddress}:${reader.implementationCode}`);
  if (new Set(identities).size !== 1) fail("CCTP_ARTIFACT_RPC_IDENTITY_DIVERGED");
  return { readers, proxyCode: readers[0].proxyCode, implementationAddress: readers[0].implementationAddress, implementationCode: readers[0].implementationCode };
}

async function readCodeQuorum(address, readers) {
  const codes = await Promise.all(readers.map((reader) => rpc(reader.endpoint, "eth_getCode", [address, "latest"]).then(hexData)));
  if (codes.some((code) => code === "0x") || new Set(codes).size !== 1) fail("CCTP_ARTIFACT_LIBRARY_CODE_DIVERGED");
  return codes[0];
}

async function rpc(endpoint, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
    if (!response.ok) fail("CCTP_ARTIFACT_RPC_HTTP_FAILED");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) fail("CCTP_ARTIFACT_RPC_RESPONSE_TOO_LARGE");
    const payload = JSON.parse(text);
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== 1 || payload.error !== undefined || !("result" in payload)) fail("CCTP_ARTIFACT_RPC_RESPONSE_INVALID");
    return payload.result;
  } catch (reason) {
    if (reason?.name === "AbortError") fail("CCTP_ARTIFACT_RPC_TIMEOUT");
    throw reason;
  } finally { clearTimeout(timeout); }
}

function linkRuntime(artifact, actualRuntime) {
  let runtime = artifact.runtime;
  const libraryAddresses = {};
  for (const libraries of Object.values(artifact.linkReferences)) {
    for (const [name, positions] of Object.entries(libraries)) {
      for (const position of positions) {
        const start = 2 + position.start * 2;
        const actual = `0x${actualRuntime.slice(start, start + position.length * 2)}`;
        if (!/^0x[0-9a-f]{40}$/.test(actual)) fail("CCTP_ARTIFACT_LIBRARY_ADDRESS_INVALID");
        if (libraryAddresses[name] && libraryAddresses[name] !== actual) fail("CCTP_ARTIFACT_LIBRARY_ADDRESS_DIVERGED");
        libraryAddresses[name] = actual;
        runtime = `${runtime.slice(0, start)}${actual.slice(2)}${runtime.slice(start + position.length * 2)}`;
      }
    }
  }
  return { runtime, libraryAddresses };
}

function embedLibraryAddress(runtime, address) { return `${runtime.slice(0, 4)}${address.slice(2).toLowerCase()}${runtime.slice(44)}`; }

function comparePartialRuntime(compiledRuntime, observedRuntime, code) {
  const compiledLogic = stripMetadata(compiledRuntime);
  const observedLogic = stripMetadata(observedRuntime);
  if (compiledLogic !== observedLogic) fail(code);
  return { compiledFullRuntimeKeccak256: keccak256Hex(compiledRuntime), observedFullRuntimeKeccak256: keccak256Hex(observedRuntime), logicRuntimeKeccak256: keccak256Hex(compiledLogic), metadataMatched: compiledRuntime === observedRuntime };
}

function assertCompilerVersion(solcValue) {
  if (typeof solcValue?.version !== "function" || !String(solcValue.version()).startsWith(COMPILER_VERSION)) fail("CCTP_ARTIFACT_COMPILER_VERSION_INVALID");
}

function stripMetadata(runtime) {
  const value = hexData(runtime);
  if (value.length < 6) fail("CCTP_ARTIFACT_METADATA_LENGTH_INVALID");
  const metadataBytes = Number.parseInt(value.slice(-4), 16);
  const removeChars = metadataBytes * 2 + 4;
  if (!Number.isSafeInteger(metadataBytes) || removeChars <= 4 || removeChars >= value.length - 2) fail("CCTP_ARTIFACT_METADATA_LENGTH_INVALID");
  return value.slice(0, value.length - removeChars);
}

function contractEvidence(sourcePath, sourceMap, artifact, observedRuntime, comparison) {
  return { sourcePath, sourceSha256: prefixedSha256(sha256(sourceMap[sourcePath].content)), metadataSha256: prefixedSha256(sha256(artifact.metadata)), observedRuntimeBytes: (observedRuntime.length - 2) / 2, ...comparison };
}

function safeHexNumber(value) { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) fail("CCTP_ARTIFACT_RPC_QUANTITY_INVALID"); const parsed = BigInt(value); if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail("CCTP_ARTIFACT_RPC_QUANTITY_INVALID"); return Number(parsed); }
function hexData(value) { if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) fail("CCTP_ARTIFACT_HEX_DATA_INVALID"); return value.toLowerCase(); }
function toPosix(value) { return value.split(sep).join("/"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function prefixedSha256(value) { return `sha256:${value}`; }
function keccak256Hex(value) { return keccak256(hexData(value)); }
function canonicalStringify(value) { return JSON.stringify(canonical(value)); }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])); return value; }
function fail(message) { throw new Error(message); }

function runSelfTests() {
  const logic = "6001600055";
  const compiled = `0x${logic}aabb0002`;
  const observed = `0x${logic}ccdd0002`;
  const comparison = comparePartialRuntime(compiled, observed, "SELF_TEST_RUNTIME_MISMATCH");
  if (comparison.metadataMatched || comparison.logicRuntimeKeccak256 !== keccak256Hex(`0x${logic}`)) fail("SELF_TEST_METADATA_STRIP_FAILED");
  assertThrows(() => comparePartialRuntime(`0x${logic}aabb0002`, `0x6002600055ccdd0002`, "SELF_TEST_RUNTIME_MISMATCH"), "SELF_TEST_RUNTIME_MISMATCH");
  assertThrows(() => assertCompilerVersion({ version: () => "0.8.30+commit.73712a01" }), "CCTP_ARTIFACT_COMPILER_VERSION_INVALID");
  if (keccak256Hex("0x") !== "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") fail("SELF_TEST_ETHEREUM_KECCAK_FAILED");
  if (canonicalStringify({ z: 1, a: { y: 2, b: 3 } }) !== '{"a":{"b":3,"y":2},"z":1}') fail("SELF_TEST_CANONICAL_JSON_FAILED");
}

function assertThrows(action, expectedMessage) {
  try { action(); }
  catch (reason) { if (reason instanceof Error && reason.message === expectedMessage) return; throw reason; }
  fail(`SELF_TEST_EXPECTED_FAILURE_MISSING:${expectedMessage}`);
}
