import { getAddress, keccak256 } from "ethers";
import { assertDistinctPublicRpcEndpoints, normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";

type FetchLike = typeof fetch;

export const BASE_SEPOLIA_CCTP_ASSET = {
  chainId: 84_532n,
  caip2: "eip155:84532",
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  symbol: "USDC",
  name: "USDC",
  decimals: 6,
  implementationSlot: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3"
} as const;

export const BASE_SEPOLIA_CCTP_ASSET_RPC_ENDPOINTS = [
  "https://sepolia.base.org/",
  "https://base-sepolia-rpc.publicnode.com/"
] as const;

export type CctpAssetIdentityReader = {
  id: string;
  chainId(): Promise<bigint>;
  blockNumber(): Promise<number>;
  code(address: string): Promise<string>;
  storage(address: string, slot: string): Promise<string>;
  call(address: string, data: string): Promise<string>;
};

export type CctpAssetIdentityObservation = {
  readerId: string;
  observedBlock: number;
  proxyCodeHash: string;
  implementationAddress: string;
  implementationCodeHash: string;
  name: string;
  symbol: string;
  decimals: number;
};

export type CctpAssetReleaseEvidence = {
  status: "quorum-observed";
  asset: typeof BASE_SEPOLIA_CCTP_ASSET;
  observations: CctpAssetIdentityObservation[];
  observedAt: number;
  executionEnabled: false;
  releaseApprovalRequired: true;
};

const MAX_RPC_RESPONSE_BYTES = 1_000_000;
const MAX_HEAD_DIVERGENCE = 12;
const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const HEX_DATA = /^0x(?:[0-9a-f]{2})*$/i;
const SELECTORS = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567" } as const;

export function createPinnedBaseCctpAssetReaders(fetchImpl: FetchLike = fetch, timeoutMs = 8_000): CctpAssetIdentityReader[] {
  const endpoints = assertDistinctPublicRpcEndpoints(BASE_SEPOLIA_CCTP_ASSET_RPC_ENDPOINTS);
  return endpoints.map((endpoint) => createCctpAssetIdentityReader(endpoint, fetchImpl, timeoutMs));
}

export async function observeBaseCctpAssetIdentity(
  readers: readonly CctpAssetIdentityReader[],
  now = Date.now()
): Promise<CctpAssetReleaseEvidence> {
  assertReaderQuorum(readers);
  const observations = await Promise.all(readers.map(async (reader): Promise<CctpAssetIdentityObservation> => {
    const [chainId, observedBlock, proxyCode, implementationWord, nameData, symbolData, decimalsData] = await Promise.all([
      reader.chainId(), reader.blockNumber(), reader.code(BASE_SEPOLIA_CCTP_ASSET.address),
      reader.storage(BASE_SEPOLIA_CCTP_ASSET.address, BASE_SEPOLIA_CCTP_ASSET.implementationSlot),
      reader.call(BASE_SEPOLIA_CCTP_ASSET.address, SELECTORS.name),
      reader.call(BASE_SEPOLIA_CCTP_ASSET.address, SELECTORS.symbol),
      reader.call(BASE_SEPOLIA_CCTP_ASSET.address, SELECTORS.decimals)
    ]);
    if (chainId !== BASE_SEPOLIA_CCTP_ASSET.chainId) throw new Error("CCTP_ASSET_RPC_CHAIN_MISMATCH");
    if (!Number.isSafeInteger(observedBlock) || observedBlock < 0) throw new Error("CCTP_ASSET_RPC_BLOCK_INVALID");
    const implementationAddress = parseImplementationAddress(implementationWord);
    const implementationCode = await reader.code(implementationAddress);
    const observation = {
      readerId: reader.id,
      observedBlock,
      proxyCodeHash: runtimeHash(proxyCode, "CCTP_ASSET_PROXY_CODE_MISSING"),
      implementationAddress,
      implementationCodeHash: runtimeHash(implementationCode, "CCTP_ASSET_IMPLEMENTATION_CODE_MISSING"),
      name: parseAbiString(nameData),
      symbol: parseAbiString(symbolData),
      decimals: parseAbiUint8(decimalsData)
    };
    if (observation.name !== BASE_SEPOLIA_CCTP_ASSET.name || observation.symbol !== BASE_SEPOLIA_CCTP_ASSET.symbol || observation.decimals !== BASE_SEPOLIA_CCTP_ASSET.decimals) throw new Error("CCTP_ASSET_METADATA_MISMATCH");
    return observation;
  }));
  const heads = observations.map((item) => item.observedBlock);
  if (Math.max(...heads) - Math.min(...heads) > MAX_HEAD_DIVERGENCE) throw new Error("CCTP_ASSET_RPC_HEAD_DIVERGED");
  const identities = observations.map((item) => `${item.proxyCodeHash}:${item.implementationAddress.toLowerCase()}:${item.implementationCodeHash}:${item.name}:${item.symbol}:${item.decimals}`);
  if (new Set(identities).size !== 1) throw new Error("CCTP_ASSET_RPC_IDENTITY_DIVERGED");
  return {
    status: "quorum-observed",
    asset: BASE_SEPOLIA_CCTP_ASSET,
    observations,
    observedAt: now,
    executionEnabled: false,
    releaseApprovalRequired: true
  };
}

function createCctpAssetIdentityReader(endpointValue: string, fetchImpl: FetchLike, timeoutMs: number): CctpAssetIdentityReader {
  const endpoint = normalizePublicRpcEndpoint(endpointValue);
  const id = new URL(endpoint).hostname.toLowerCase();
  let requestId = 0;
  const request = async (method: "eth_chainId" | "eth_blockNumber" | "eth_getCode" | "eth_getStorageAt" | "eth_call", params: readonly unknown[]): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const rpcId = ++requestId;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
        credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal
      });
      if (!response.ok) throw new Error("CCTP_ASSET_RPC_HTTP_FAILED");
      const text = await readBoundedResponse(response);
      let payload: { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
      try { payload = JSON.parse(text) as typeof payload; } catch { throw new Error("CCTP_ASSET_RPC_RESPONSE_INVALID"); }
      if (!payload || typeof payload !== "object" || payload.jsonrpc !== "2.0" || payload.id !== rpcId || payload.error !== undefined || !("result" in payload)) throw new Error("CCTP_ASSET_RPC_RESPONSE_INVALID");
      return payload.result;
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") throw new Error("CCTP_ASSET_RPC_TIMEOUT");
      throw reason;
    } finally { clearTimeout(timeout); }
  };
  return {
    id,
    chainId: async () => parseRpcBigInt(await request("eth_chainId", [])),
    blockNumber: async () => parseRpcSafeNumber(await request("eth_blockNumber", [])),
    code: async (address) => parseHexData(await request("eth_getCode", [normalizedAddress(address), "latest"])),
    storage: async (address, slot) => parseHexData(await request("eth_getStorageAt", [normalizedAddress(address), parseStorageSlot(slot), "latest"])),
    call: async (address, data) => parseHexData(await request("eth_call", [{ to: normalizedAddress(address), data: parseHexData(data) }, "latest"]))
  };
}

function assertReaderQuorum(readers: readonly CctpAssetIdentityReader[]): void {
  if (readers.length !== 2 || readers.some((reader) => !reader.id.trim() || reader.id.length > 100) || new Set(readers.map((reader) => reader.id.toLowerCase())).size !== readers.length) throw new Error("CCTP_ASSET_RPC_QUORUM_INVALID");
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RPC_RESPONSE_BYTES) throw new Error("CCTP_ASSET_RPC_RESPONSE_TOO_LARGE");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RPC_RESPONSE_BYTES) throw new Error("CCTP_ASSET_RPC_RESPONSE_TOO_LARGE");
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
    if (total > MAX_RPC_RESPONSE_BYTES) { await reader.cancel(); throw new Error("CCTP_ASSET_RPC_RESPONSE_TOO_LARGE"); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseRpcBigInt(value: unknown): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) throw new Error("CCTP_ASSET_RPC_QUANTITY_INVALID");
  return BigInt(value);
}

function parseRpcSafeNumber(value: unknown): number {
  const parsed = parseRpcBigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CCTP_ASSET_RPC_QUANTITY_INVALID");
  return Number(parsed);
}

function parseHexData(value: unknown): string {
  if (typeof value !== "string" || !HEX_DATA.test(value)) throw new Error("CCTP_ASSET_RPC_DATA_INVALID");
  return value.toLowerCase();
}

function parseStorageSlot(value: string): string {
  const slot = parseHexData(value);
  if (slot.length !== 66) throw new Error("CCTP_ASSET_STORAGE_SLOT_INVALID");
  return slot;
}

function parseImplementationAddress(value: string): string {
  const word = parseHexData(value);
  if (word.length !== 66 || !/^0x0{24}[0-9a-f]{40}$/.test(word)) throw new Error("CCTP_ASSET_IMPLEMENTATION_SLOT_INVALID");
  const address = normalizedAddress(`0x${word.slice(-40)}`);
  if (address === "0x0000000000000000000000000000000000000000") throw new Error("CCTP_ASSET_IMPLEMENTATION_SLOT_INVALID");
  return address;
}

function parseAbiUint8(value: string): number {
  const word = parseHexData(value);
  if (word.length !== 66) throw new Error("CCTP_ASSET_METADATA_INVALID");
  const parsed = BigInt(word);
  if (parsed > 255n) throw new Error("CCTP_ASSET_METADATA_INVALID");
  return Number(parsed);
}

function parseAbiString(value: string): string {
  const data = parseHexData(value);
  if (data.length < 130 || BigInt(`0x${data.slice(2, 66)}`) !== 32n) throw new Error("CCTP_ASSET_METADATA_INVALID");
  const length = BigInt(`0x${data.slice(66, 130)}`);
  if (length > 64n) throw new Error("CCTP_ASSET_METADATA_INVALID");
  const byteLength = Number(length);
  const paddedLength = Math.ceil(byteLength / 32) * 64;
  if (data.length !== 130 + paddedLength || !/^0*$/.test(data.slice(130 + byteLength * 2))) throw new Error("CCTP_ASSET_METADATA_INVALID");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(data.slice(130, 130 + byteLength * 2).match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))); }
  catch { throw new Error("CCTP_ASSET_METADATA_INVALID"); }
}

function runtimeHash(code: string, errorCode: string): string {
  const normalized = parseHexData(code);
  if (normalized === "0x") throw new Error(errorCode);
  return keccak256(normalized).toLowerCase();
}

function normalizedAddress(value: string): string {
  try { return getAddress(value); } catch { throw new Error("CCTP_ASSET_ADDRESS_INVALID"); }
}
