import { base58 } from "@scure/base";
import { normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";
import { verifyEvmAssetOnChain, type EvmAssetMetadataReader, type OnChainAssetCheck } from "./token-source";
import type { UniversalAsset } from "./types";

type FetchLike = typeof fetch;

const MAX_RESPONSE_BYTES = 1_000_000;
const SOLANA_TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);

export type SolanaMintReader = {
  readonly id: string;
  genesisHash(): Promise<string>;
  readMint(address: string): Promise<{ ownerProgram: string; decimals: number; initialized: boolean }>;
};

export type CosmosDenomReader = {
  readonly id: string;
  chainId(): Promise<string>;
  readDenomMetadata(denom: string): Promise<{
    base: string;
    display: string;
    name: string;
    symbol: string;
    denomUnits: Array<{ denom: string; exponent: number }>;
  }>;
};

export type UniversalAssetReaders = {
  evm?: EvmAssetMetadataReader;
  solana?: readonly SolanaMintReader[];
  cosmos?: readonly CosmosDenomReader[];
};

export async function verifyUniversalAssetOnChain(asset: UniversalAsset, readers: UniversalAssetReaders): Promise<OnChainAssetCheck> {
  if (asset.assetType.startsWith("eip155:")) {
    return readers.evm
      ? verifyEvmAssetOnChain(asset, readers.evm)
      : unchecked(asset, "No EVM reader is configured; metadata was not guessed.");
  }
  if (asset.assetType.startsWith("solana:")) {
    return readers.solana
      ? verifySolanaAssetOnChainQuorum(asset, readers.solana)
      : unchecked(asset, "No independent Solana RPC quorum is configured; mint state was not guessed.");
  }
  if (asset.assetType.startsWith("cosmos:")) {
    return readers.cosmos
      ? verifyCosmosAssetOnChainQuorum(asset, readers.cosmos)
      : unchecked(asset, "No independent Cosmos REST quorum is configured; denom metadata was not guessed.");
  }
  return unchecked(asset, "No read-only verifier is installed for this asset namespace.");
}

export async function verifySolanaAssetOnChainQuorum(asset: UniversalAsset, readers: readonly SolanaMintReader[]): Promise<OnChainAssetCheck> {
  if (!hasIndependentReaderQuorum(readers)) return unchecked(asset, "Two independent Solana RPC hosts are required; mint state was not guessed.");
  const checks = await Promise.all(readers.map((reader) => verifySolanaAssetOnChain(asset, reader)));
  return aggregateQuorum(asset, checks, "partial", "Two independent Solana RPC hosts agree on the CAIP-2 prefix, mint owner, initialized state, and decimals. Symbol and name remain publisher claims.");
}

export async function verifyCosmosAssetOnChainQuorum(asset: UniversalAsset, readers: readonly CosmosDenomReader[]): Promise<OnChainAssetCheck> {
  if (!hasIndependentReaderQuorum(readers)) return unchecked(asset, "Two independent Cosmos REST hosts are required; denom metadata was not guessed.");
  const checks = await Promise.all(readers.map((reader) => verifyCosmosAssetOnChain(asset, reader)));
  return aggregateQuorum(asset, checks, "verified", "Two independent Cosmos REST hosts agree on chain ID and exact current bank metadata.");
}

export async function verifySolanaAssetOnChain(asset: UniversalAsset, reader: SolanaMintReader): Promise<OnChainAssetCheck> {
  const parsed = parseSolanaAssetType(asset.assetType);
  if (!parsed) return unchecked(asset, "This verifier only handles valid Solana SPL mint identities.");
  try {
    if ((await reader.genesisHash()).slice(0, 32) !== parsed.genesisHashPrefix) return unchecked(asset, "The configured Solana RPC serves a different CAIP-2 genesis hash prefix; metadata was not guessed.");
    const mint = await reader.readMint(parsed.mint);
    const observed = { decimals: mint.decimals, authority: mint.ownerProgram };
    if (!SOLANA_TOKEN_PROGRAMS.has(mint.ownerProgram)) return mismatch(asset, "The mint account is not owned by an approved Solana Token program.", observed);
    if (!mint.initialized) return mismatch(asset, "The Solana mint account is not initialized.", observed);
    if (mint.decimals !== asset.decimals) return mismatch(asset, "The current mint decimals differ from the signed record.", observed);
    return {
      assetType: asset.assetType,
      status: "partial",
      message: "CAIP-2 genesis hash prefix, mint owner, initialized state, and decimals match. SPL mint state does not prove the signed symbol or name.",
      observed
    };
  } catch {
    return unchecked(asset, "The configured Solana RPC could not verify current mint state; nothing was inferred.");
  }
}

export async function verifyCosmosAssetOnChain(asset: UniversalAsset, reader: CosmosDenomReader): Promise<OnChainAssetCheck> {
  const parsed = parseCosmosAssetType(asset.assetType);
  if (!parsed) return unchecked(asset, "This verifier only handles valid Cosmos bank denom identities.");
  try {
    if (await reader.chainId() !== parsed.chainId) return unchecked(asset, "The configured Cosmos REST endpoint serves a different chain; metadata was not guessed.");
    const metadata = await reader.readDenomMetadata(parsed.denom);
    const displayUnit = metadata.denomUnits.find((unit) => unit.denom === metadata.display);
    const observed = { symbol: metadata.symbol, name: metadata.name, decimals: displayUnit?.exponent ?? -1, authority: metadata.base };
    const matches = metadata.base === parsed.denom && metadata.symbol === asset.symbol && metadata.name === asset.name && displayUnit?.exponent === asset.decimals;
    return matches
      ? { assetType: asset.assetType, status: "verified", message: "Chain ID, base denom, display unit, symbol, name, and decimals match current bank metadata.", observed }
      : mismatch(asset, "Current Cosmos bank metadata differs from the signed record.", observed);
  } catch {
    return unchecked(asset, "The configured Cosmos REST endpoint could not verify current denom metadata; nothing was inferred.");
  }
}

export function createSolanaJsonRpcMintReader(endpointValue: string, fetchImpl: FetchLike = fetch, timeoutMs = 8_000): SolanaMintReader {
  const endpoint = normalizeReadEndpoint(endpointValue);
  const request = createJsonRpcRequester(endpoint, fetchImpl, timeoutMs);
  return {
    id: new URL(endpoint).hostname.toLowerCase(),
    genesisHash: async () => requireString(await request("getGenesisHash", []), "NON_EVM_RESPONSE_INVALID"),
    readMint: async (address) => {
      const value = await request("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]);
      if (!value || typeof value !== "object") throw new Error("NON_EVM_RESPONSE_INVALID");
      const account = (value as { value?: unknown }).value;
      if (!account || typeof account !== "object") throw new Error("NON_EVM_RESPONSE_INVALID");
      const record = account as { owner?: unknown; data?: unknown };
      const data = record.data as { program?: unknown; parsed?: { type?: unknown; info?: { decimals?: unknown; isInitialized?: unknown } } } | undefined;
      if (typeof record.owner !== "string" || data?.program !== "spl-token" || data.parsed?.type !== "mint") throw new Error("NON_EVM_RESPONSE_INVALID");
      const decimals = data.parsed.info?.decimals;
      const initialized = data.parsed.info?.isInitialized;
      if (!Number.isInteger(decimals) || Number(decimals) < 0 || Number(decimals) > 255 || typeof initialized !== "boolean") throw new Error("NON_EVM_RESPONSE_INVALID");
      return { ownerProgram: record.owner, decimals: Number(decimals), initialized };
    }
  };
}

export function createCosmosRestDenomReader(endpointValue: string, fetchImpl: FetchLike = fetch, timeoutMs = 8_000): CosmosDenomReader {
  const endpoint = normalizeReadEndpoint(endpointValue);
  const get = async (path: string): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, endpoint), { method: "GET", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("NON_EVM_HTTP_FAILED");
      return JSON.parse(await readBoundedResponse(response));
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") throw new Error("NON_EVM_TIMEOUT");
      throw reason;
    } finally { clearTimeout(timeout); }
  };
  return {
    id: new URL(endpoint).hostname.toLowerCase(),
    chainId: async () => {
      const payload = await get("cosmos/base/tendermint/v1beta1/node_info") as { default_node_info?: { network?: unknown } };
      return requireString(payload?.default_node_info?.network, "NON_EVM_RESPONSE_INVALID");
    },
    readDenomMetadata: async (denom) => {
      const payload = await get(`cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`) as { metadata?: unknown };
      if (!payload?.metadata || typeof payload.metadata !== "object") throw new Error("NON_EVM_RESPONSE_INVALID");
      const metadata = payload.metadata as Record<string, unknown>;
      const units = metadata.denom_units;
      if (!Array.isArray(units)) throw new Error("NON_EVM_RESPONSE_INVALID");
      const denomUnits = units.map((unit) => {
        if (!unit || typeof unit !== "object") throw new Error("NON_EVM_RESPONSE_INVALID");
        const record = unit as Record<string, unknown>;
        const denomValue = requireString(record.denom, "NON_EVM_RESPONSE_INVALID");
        const exponent = Number(record.exponent);
        if (!Number.isInteger(exponent) || exponent < 0 || exponent > 255) throw new Error("NON_EVM_RESPONSE_INVALID");
        return { denom: denomValue, exponent };
      });
      return {
        base: requireString(metadata.base, "NON_EVM_RESPONSE_INVALID"),
        display: requireString(metadata.display, "NON_EVM_RESPONSE_INVALID"),
        name: requireString(metadata.name, "NON_EVM_RESPONSE_INVALID"),
        symbol: requireString(metadata.symbol, "NON_EVM_RESPONSE_INVALID"),
        denomUnits
      };
    }
  };
}

export function createSolanaJsonRpcMintReaderQuorum(endpointValues: readonly string[], fetchImpl: FetchLike = fetch, timeoutMs = 8_000): SolanaMintReader[] {
  return normalizeIndependentReadEndpoints(endpointValues).map((endpoint) => createSolanaJsonRpcMintReader(endpoint, fetchImpl, timeoutMs));
}

export function createCosmosRestDenomReaderQuorum(endpointValues: readonly string[], fetchImpl: FetchLike = fetch, timeoutMs = 8_000): CosmosDenomReader[] {
  return normalizeIndependentReadEndpoints(endpointValues).map((endpoint) => createCosmosRestDenomReader(endpoint, fetchImpl, timeoutMs));
}

function createJsonRpcRequester(endpointValue: string, fetchImpl: FetchLike, timeoutMs: number) {
  const endpoint = normalizeReadEndpoint(endpointValue);
  let requestId = 0;
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const id = ++requestId;
    try {
      const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("NON_EVM_HTTP_FAILED");
      const payload = JSON.parse(await readBoundedResponse(response)) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
      if (!payload || payload.jsonrpc !== "2.0" || payload.id !== id || payload.error !== undefined || !("result" in payload)) throw new Error("NON_EVM_RESPONSE_INVALID");
      return payload.result;
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") throw new Error("NON_EVM_TIMEOUT");
      throw reason;
    } finally { clearTimeout(timeout); }
  };
}

function normalizeReadEndpoint(value: string): string {
  try { return normalizePublicRpcEndpoint(value); }
  catch { throw new Error("NON_EVM_ENDPOINT_NOT_PUBLIC"); }
}

function normalizeIndependentReadEndpoints(values: readonly string[]): string[] {
  if (values.length !== 2 || values.some((value) => !value.trim())) throw new Error("NON_EVM_READER_QUORUM_REQUIRED");
  const endpoints = values.map(normalizeReadEndpoint);
  const hosts = endpoints.map((endpoint) => new URL(endpoint).hostname.toLowerCase());
  if (new Set(endpoints).size !== endpoints.length || new Set(hosts).size !== hosts.length) throw new Error("NON_EVM_READER_QUORUM_NOT_INDEPENDENT");
  return endpoints;
}

function hasIndependentReaderQuorum(readers: readonly { id: string }[]): boolean {
  return readers.length === 2 && readers.every((reader) => Boolean(reader.id)) && new Set(readers.map((reader) => reader.id.toLowerCase())).size === 2;
}

function aggregateQuorum(asset: UniversalAsset, checks: readonly OnChainAssetCheck[], successStatus: "verified" | "partial", successMessage: string): OnChainAssetCheck {
  const mismatchCheck = checks.find((check) => check.status === "mismatch");
  if (mismatchCheck) return { assetType: asset.assetType, status: "mismatch", message: "At least one independent reader reported metadata that does not match the signed record.", observed: consensusObservation(checks) };
  if (checks.some((check) => check.status === "not-checked")) return unchecked(asset, "The independent reader quorum was incomplete; no verification result was inferred.");
  if (checks.some((check) => check.status !== successStatus)) return unchecked(asset, "The independent readers returned incompatible verification states; no result was inferred.");
  const observed = consensusObservation(checks);
  if (!observed) return mismatch(asset, "Independent readers disagreed on current on-chain metadata.", { decimals: -1 });
  return { assetType: asset.assetType, status: successStatus, message: successMessage, observed };
}

function consensusObservation(checks: readonly OnChainAssetCheck[]): NonNullable<OnChainAssetCheck["observed"]> | undefined {
  const observations = checks.map((check) => check.observed);
  const first = observations[0];
  if (!first || observations.some((observed) => !observed)) return undefined;
  const fingerprints = observations.map((observed) => JSON.stringify(observed));
  return new Set(fingerprints).size === 1 ? first : undefined;
}

function parseSolanaAssetType(assetType: string): { genesisHashPrefix: string; mint: string } | undefined {
  const match = /^solana:([1-9A-HJ-NP-Za-km-z]{32})\/spl:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(assetType);
  if (!match) return undefined;
  try {
    if (base58.decode(match[2]).length !== 32) return undefined;
    return { genesisHashPrefix: match[1], mint: match[2] };
  } catch { return undefined; }
}

function parseCosmosAssetType(assetType: string): { chainId: string; denom: string } | undefined {
  const match = /^cosmos:([a-zA-Z0-9._-]{1,64})\/(denom|ibc):([^\s/]{1,128})$/.exec(assetType);
  if (!match) return undefined;
  return { chainId: match[1], denom: match[2] === "ibc" ? `ibc/${match[3]}` : match[3] };
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("NON_EVM_RESPONSE_TOO_LARGE");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("NON_EVM_RESPONSE_TOO_LARGE");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("NON_EVM_RESPONSE_TOO_LARGE");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function requireString(value: unknown, error: string): string {
  if (typeof value !== "string" || !value) throw new Error(error);
  return value;
}

function unchecked(asset: UniversalAsset, message: string): OnChainAssetCheck {
  return { assetType: asset.assetType, status: "not-checked", message };
}

function mismatch(asset: UniversalAsset, message: string, observed: NonNullable<OnChainAssetCheck["observed"]>): OnChainAssetCheck {
  return { assetType: asset.assetType, status: "mismatch", message, observed };
}
