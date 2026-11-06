import { keccak256, toUtf8Bytes } from "ethers";
import { normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";

export type CctpEvmSourceLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
};

export type CctpEvmSourceReceipt = {
  transactionHash: string;
  status: 0 | 1;
  blockNumber: number;
  blockHash: string;
  logs: CctpEvmSourceLog[];
};

export type CctpEvmSourceReader = {
  readonly id: string;
  chainId(): Promise<bigint>;
  blockNumber(): Promise<number>;
  receipt(transactionHash: string): Promise<CctpEvmSourceReceipt | null>;
};

export type CctpEvmSourceConfig = {
  chainId: bigint;
  messageTransmitter: string;
  rpcEndpoints: readonly [string, string];
};

export type VerifiedCctpEvmSourceMessage = {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  confirmations: number;
  readerIds: readonly [string, string];
};

const MESSAGE_SENT_TOPIC = keccak256(toUtf8Bytes("MessageSent(bytes)")).toLowerCase();
const MESSAGE_TRANSMITTER_V2 = "0xe737e5cebeeba77efe34d4aa090756590b1ce275";
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_HEAD_DIVERGENCE = 12;
const REQUIRED_CONFIRMATIONS = 2;

const CONFIGS: Record<number, CctpEvmSourceConfig> = {
  6: { chainId: 84_532n, messageTransmitter: MESSAGE_TRANSMITTER_V2, rpcEndpoints: ["https://sepolia.base.org/", "https://base-sepolia-rpc.publicnode.com/"] },
  3: { chainId: 421_614n, messageTransmitter: MESSAGE_TRANSMITTER_V2, rpcEndpoints: ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com/"] }
};

export function cctpEvmSourceConfig(sourceDomain: number): CctpEvmSourceConfig | null {
  const config = CONFIGS[sourceDomain];
  return config ? { ...config, rpcEndpoints: [...config.rpcEndpoints] as [string, string] } : null;
}

export function createCctpEvmSourceReaderQuorum(sourceDomain: number, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): CctpEvmSourceReader[] | null {
  const config = cctpEvmSourceConfig(sourceDomain);
  if (!config) return null;
  const endpoints = config.rpcEndpoints.map(normalizePublicRpcEndpoint);
  const hosts = endpoints.map((endpoint) => new URL(endpoint).hostname.toLowerCase());
  if (new Set(endpoints).size !== 2 || new Set(hosts).size !== 2) throw new Error("CCTP_SOURCE_RPC_QUORUM_NOT_INDEPENDENT");
  return endpoints.map((endpoint) => createReader(endpoint, fetchImpl, timeoutMs));
}

export async function verifyCctpEvmSourceMessage(input: {
  sourceDomain: number;
  transactionHash: string;
  rawMessage: string;
  readers: readonly CctpEvmSourceReader[];
}): Promise<VerifiedCctpEvmSourceMessage | null> {
  const config = cctpEvmSourceConfig(input.sourceDomain);
  if (!config || !isHash(input.transactionHash) || !isData(input.rawMessage) || input.readers.length !== 2) throw new Error("CCTP_SOURCE_PROOF_INPUT_INVALID");
  const ids = input.readers.map((reader) => reader.id.toLowerCase());
  if (ids.some((id) => !id || id.length > 255) || new Set(ids).size !== 2) throw new Error("CCTP_SOURCE_RPC_QUORUM_NOT_INDEPENDENT");
  const results = await Promise.all(input.readers.map(async (reader) => {
    const [chainId, head, receipt] = await Promise.all([reader.chainId(), reader.blockNumber(), reader.receipt(input.transactionHash)]);
    if (chainId !== config.chainId) throw new Error("CCTP_SOURCE_CHAIN_MISMATCH");
    if (!Number.isSafeInteger(head) || head < 0) throw new Error("CCTP_SOURCE_HEAD_INVALID");
    if (receipt) assertReceipt(receipt, input.transactionHash, head);
    return { id: reader.id.toLowerCase(), head, receipt };
  }));
  if (Math.abs(results[0].head - results[1].head) > MAX_HEAD_DIVERGENCE) throw new Error("CCTP_SOURCE_HEAD_DIVERGENCE");
  if ((results[0].receipt === null) !== (results[1].receipt === null)) throw new Error("CCTP_SOURCE_RECEIPT_QUORUM_MISMATCH");
  if (!results[0].receipt || !results[1].receipt) return null;
  const left = results[0].receipt, right = results[1].receipt;
  if (receiptFingerprint(left) !== receiptFingerprint(right)) throw new Error("CCTP_SOURCE_RECEIPT_QUORUM_MISMATCH");
  if (left.status !== 1) throw new Error("CCTP_SOURCE_TRANSACTION_REVERTED");
  const matching = left.logs.filter((log) => {
    if (log.address !== config.messageTransmitter || log.topics.length !== 1 || log.topics[0] !== MESSAGE_SENT_TOPIC) return false;
    return decodeCanonicalBytes(log.data) === input.rawMessage.toLowerCase();
  });
  if (matching.length !== 1) throw new Error(matching.length ? "CCTP_SOURCE_MESSAGE_LOG_AMBIGUOUS" : "CCTP_SOURCE_MESSAGE_LOG_MISSING");
  const confirmations = Math.min(results[0].head, results[1].head) - left.blockNumber + 1;
  if (confirmations < REQUIRED_CONFIRMATIONS) return null;
  return {
    transactionHash: left.transactionHash, blockNumber: left.blockNumber, blockHash: left.blockHash,
    logIndex: matching[0].logIndex, confirmations, readerIds: [results[0].id, results[1].id]
  };
}

function createReader(endpoint: string, fetchImpl: typeof fetch, timeoutMs: number): CctpEvmSourceReader {
  let requestId = 0;
  const request = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const id = ++requestId;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: controller.signal
      });
      if (!response.ok) throw new Error("CCTP_SOURCE_RPC_HTTP_FAILED");
      const payload = JSON.parse(await readBounded(response)) as Record<string, unknown>;
      if (!isPlainObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== id || payload.error !== undefined || !Object.prototype.hasOwnProperty.call(payload, "result")) throw new Error("CCTP_SOURCE_RPC_RESPONSE_INVALID");
      return payload.result;
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") throw new Error("CCTP_SOURCE_RPC_TIMEOUT");
      throw reason;
    } finally { clearTimeout(timeout); }
  };
  return {
    id: new URL(endpoint).hostname.toLowerCase(),
    chainId: async () => quantityBigInt(await request("eth_chainId", [])),
    blockNumber: async () => quantityNumber(await request("eth_blockNumber", [])),
    receipt: async (hash) => {
      if (!isHash(hash)) throw new Error("CCTP_SOURCE_TRANSACTION_HASH_INVALID");
      const value = await request("eth_getTransactionReceipt", [hash]);
      return value === null ? null : parseReceipt(value);
    }
  };
}

function parseReceipt(value: unknown): CctpEvmSourceReceipt {
  if (!isPlainObject(value) || !Array.isArray(value.logs) || value.logs.length > 256) throw new Error("CCTP_SOURCE_RPC_RECEIPT_INVALID");
  const status = quantityNumber(value.status);
  if (status !== 0 && status !== 1) throw new Error("CCTP_SOURCE_RPC_RECEIPT_INVALID");
  const transactionHash = requiredHash(value.transactionHash), blockNumber = quantityNumber(value.blockNumber), blockHash = requiredHash(value.blockHash);
  const logs = value.logs.map((item) => parseLog(item, transactionHash, blockNumber, blockHash));
  return { transactionHash, status, blockNumber, blockHash, logs };
}

function parseLog(value: unknown, transactionHash: string, blockNumber: number, blockHash: string): CctpEvmSourceLog {
  if (!isPlainObject(value) || typeof value.address !== "string" || !/^0x[0-9a-f]{40}$/i.test(value.address) || !Array.isArray(value.topics) || value.topics.length > 4 || value.topics.some((topic) => typeof topic !== "string" || !isHash(topic)) || !isData(value.data) || value.removed !== false) throw new Error("CCTP_SOURCE_RPC_LOG_INVALID");
  if (requiredHash(value.transactionHash) !== transactionHash || quantityNumber(value.blockNumber) !== blockNumber || requiredHash(value.blockHash) !== blockHash) throw new Error("CCTP_SOURCE_RPC_LOG_INVALID");
  return { address: value.address.toLowerCase(), topics: value.topics.map((topic) => String(topic).toLowerCase()), data: String(value.data).toLowerCase(), transactionHash, blockNumber, blockHash, logIndex: quantityNumber(value.logIndex) };
}

function assertReceipt(receipt: CctpEvmSourceReceipt, transactionHash: string, head: number): void {
  if (!isHash(receipt.transactionHash) || receipt.transactionHash !== transactionHash.toLowerCase() || (receipt.status !== 0 && receipt.status !== 1) || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || receipt.blockNumber > head || !isHash(receipt.blockHash) || !Array.isArray(receipt.logs) || receipt.logs.length > 256) throw new Error("CCTP_SOURCE_RECEIPT_INVALID");
  receipt.logs.forEach((log) => {
    if (!/^0x[0-9a-f]{40}$/.test(log.address) || !Array.isArray(log.topics) || log.topics.length > 4 || log.topics.some((topic) => !isHash(topic)) || !isData(log.data) || log.transactionHash !== receipt.transactionHash || log.blockNumber !== receipt.blockNumber || log.blockHash !== receipt.blockHash || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) throw new Error("CCTP_SOURCE_RECEIPT_INVALID");
  });
}

function receiptFingerprint(receipt: CctpEvmSourceReceipt): string {
  return JSON.stringify(receipt);
}

function decodeCanonicalBytes(value: string): string {
  const bytes = hexBytes(value);
  if (bytes.length < 64 || bytes.length % 32 !== 0 || uint256(bytes, 0) !== 32n) throw new Error("CCTP_SOURCE_MESSAGE_LOG_INVALID");
  const length = uint256(bytes, 32);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CCTP_SOURCE_MESSAGE_LOG_INVALID");
  const size = Number(length), padded = Math.ceil(size / 32) * 32;
  if (bytes.length !== 64 + padded || bytes.slice(64 + size).some((byte) => byte !== 0)) throw new Error("CCTP_SOURCE_MESSAGE_LOG_INVALID");
  return `0x${hex(bytes.slice(64, 64 + size))}`;
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("CCTP_SOURCE_RPC_RESPONSE_TOO_LARGE");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("CCTP_SOURCE_RPC_RESPONSE_TOO_LARGE");
    return text;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let total = 0, text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("CCTP_SOURCE_RPC_RESPONSE_TOO_LARGE"); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function quantityBigInt(value: unknown): bigint { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error("CCTP_SOURCE_RPC_QUANTITY_INVALID"); return BigInt(value); }
function quantityNumber(value: unknown): number { const parsed = quantityBigInt(value); if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CCTP_SOURCE_RPC_QUANTITY_INVALID"); return Number(parsed); }
function requiredHash(value: unknown): string { if (typeof value !== "string" || !isHash(value)) throw new Error("CCTP_SOURCE_RPC_HASH_INVALID"); return value.toLowerCase(); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value); }
function isData(value: unknown): value is string { return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value); }
function hexBytes(value: string): Uint8Array { const output = new Uint8Array((value.length - 2) / 2); for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16); return output; }
function uint256(bytes: Uint8Array, offset: number): bigint { return BigInt(`0x${hex(bytes.slice(offset, offset + 32))}`); }
function hex(bytes: Uint8Array): string { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function isPlainObject(value: unknown): value is Record<string, any> { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
