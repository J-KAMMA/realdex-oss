import { keccak256, toUtf8Bytes } from "ethers";
import { normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";
import type { CctpEvmSourceLog as EvmLog, CctpEvmSourceReader as EvmReader, CctpEvmSourceReceipt as EvmReceipt } from "./cctp-evm-source";

export type CctpEvmDestinationReader = EvmReader;
export type CctpEvmDestinationReceipt = EvmReceipt;

export type CctpEvmDestinationConfig = {
  chainId: bigint;
  messageTransmitter: string;
  tokenMessenger: string;
  mintToken: string;
  rpcEndpoints: readonly [string, string];
};

export type VerifiedCctpEvmDestination = {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  messageLogIndex: number;
  mintLogIndex: number;
  confirmations: number;
  readerIds: readonly [string, string];
};

const MESSAGE_RECEIVED_TOPIC = keccak256(toUtf8Bytes("MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)")).toLowerCase();
const MINT_AND_WITHDRAW_TOPIC = keccak256(toUtf8Bytes("MintAndWithdraw(address,uint256,address,uint256)")).toLowerCase();
const MESSAGE_TRANSMITTER_V2 = "0xe737e5cebeeba77efe34d4aa090756590b1ce275";
const TOKEN_MESSENGER_V2 = "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa";
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_HEAD_DIVERGENCE = 12;
const REQUIRED_CONFIRMATIONS = 2;

const CONFIGS: Record<number, CctpEvmDestinationConfig> = {
  6: { chainId: 84_532n, messageTransmitter: MESSAGE_TRANSMITTER_V2, tokenMessenger: TOKEN_MESSENGER_V2, mintToken: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", rpcEndpoints: ["https://sepolia.base.org/", "https://base-sepolia-rpc.publicnode.com/"] },
  3: { chainId: 421_614n, messageTransmitter: MESSAGE_TRANSMITTER_V2, tokenMessenger: TOKEN_MESSENGER_V2, mintToken: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", rpcEndpoints: ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com/"] }
};

export function cctpEvmDestinationConfig(destinationDomain: number): CctpEvmDestinationConfig | null {
  const config = CONFIGS[destinationDomain];
  return config ? { ...config, rpcEndpoints: [...config.rpcEndpoints] as [string, string] } : null;
}

export function createCctpEvmDestinationReaderQuorum(destinationDomain: number, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): CctpEvmDestinationReader[] | null {
  const config = cctpEvmDestinationConfig(destinationDomain);
  if (!config) return null;
  const endpoints = config.rpcEndpoints.map(normalizePublicRpcEndpoint);
  const hosts = endpoints.map((endpoint) => new URL(endpoint).hostname.toLowerCase());
  if (new Set(endpoints).size !== 2 || new Set(hosts).size !== 2) throw new Error("CCTP_DESTINATION_RPC_QUORUM_NOT_INDEPENDENT");
  return endpoints.map((endpoint) => createReader(endpoint, fetchImpl, timeoutMs));
}

export async function verifyCctpEvmDestination(input: {
  sourceDomain: number;
  destinationDomain: number;
  transactionHash: string;
  rawMessage: string;
  readers: readonly CctpEvmDestinationReader[];
}): Promise<VerifiedCctpEvmDestination | null> {
  const config = cctpEvmDestinationConfig(input.destinationDomain);
  if (!config || !Number.isInteger(input.sourceDomain) || input.sourceDomain < 0 || input.sourceDomain > 100 || !isHash(input.transactionHash) || !isData(input.rawMessage) || input.readers.length !== 2) throw new Error("CCTP_DESTINATION_PROOF_INPUT_INVALID");
  const expected = parseExpectedMessage(input.rawMessage, input.sourceDomain, input.destinationDomain, config);
  const ids = input.readers.map((reader) => reader.id.toLowerCase());
  if (ids.some((id) => !id || id.length > 255) || new Set(ids).size !== 2) throw new Error("CCTP_DESTINATION_RPC_QUORUM_NOT_INDEPENDENT");
  const results = await Promise.all(input.readers.map(async (reader) => {
    const [chainId, head, receipt] = await Promise.all([reader.chainId(), reader.blockNumber(), reader.receipt(input.transactionHash)]);
    if (chainId !== config.chainId) throw new Error("CCTP_DESTINATION_CHAIN_MISMATCH");
    if (!Number.isSafeInteger(head) || head < 0) throw new Error("CCTP_DESTINATION_HEAD_INVALID");
    if (receipt) assertReceipt(receipt, input.transactionHash, head);
    return { id: reader.id.toLowerCase(), head, receipt };
  }));
  if (Math.abs(results[0].head - results[1].head) > MAX_HEAD_DIVERGENCE) throw new Error("CCTP_DESTINATION_HEAD_DIVERGENCE");
  if ((results[0].receipt === null) !== (results[1].receipt === null)) throw new Error("CCTP_DESTINATION_RECEIPT_QUORUM_MISMATCH");
  if (!results[0].receipt || !results[1].receipt) return null;
  const left = results[0].receipt, right = results[1].receipt;
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error("CCTP_DESTINATION_RECEIPT_QUORUM_MISMATCH");
  if (left.status !== 1) throw new Error("CCTP_DESTINATION_TRANSACTION_REVERTED");
  const received = left.logs.filter((log) => matchesMessageReceived(log, config, expected));
  if (received.length !== 1) throw new Error(received.length ? "CCTP_DESTINATION_MESSAGE_LOG_AMBIGUOUS" : "CCTP_DESTINATION_MESSAGE_LOG_MISSING");
  const minted = left.logs.filter((log) => matchesMintAndWithdraw(log, config, expected));
  if (minted.length !== 1) throw new Error(minted.length ? "CCTP_DESTINATION_MINT_LOG_AMBIGUOUS" : "CCTP_DESTINATION_MINT_LOG_MISSING");
  const confirmations = Math.min(results[0].head, results[1].head) - left.blockNumber + 1;
  if (confirmations < REQUIRED_CONFIRMATIONS) return null;
  return { transactionHash: left.transactionHash, blockNumber: left.blockNumber, blockHash: left.blockHash, messageLogIndex: received[0].logIndex, mintLogIndex: minted[0].logIndex, confirmations, readerIds: [results[0].id, results[1].id] };
}

type ExpectedMessage = { sourceDomain: bigint; nonce: string; headerSender: string; finalityThreshold: bigint; body: string; mintRecipientTopic: string; amount: bigint; fee: bigint };

function parseExpectedMessage(raw: string, sourceDomain: number, destinationDomain: number, config: CctpEvmDestinationConfig): ExpectedMessage {
  const bytes = hexBytes(raw);
  if (bytes.length < 376 || uint32(bytes, 0) !== 1 || uint32(bytes, 4) !== sourceDomain || uint32(bytes, 8) !== destinationDomain || bytes32(bytes, 76) !== addressTopic(config.tokenMessenger) || uint32(bytes, 148) !== 1) throw new Error("CCTP_DESTINATION_MESSAGE_INVALID");
  const amount = uint256(bytes, 216), fee = uint256(bytes, 312);
  if (amount <= 0n || fee >= amount) throw new Error("CCTP_DESTINATION_MESSAGE_INVALID");
  const mintRecipient = bytes32(bytes, 184);
  if (!/^0x0{24}[0-9a-f]{40}$/.test(mintRecipient)) throw new Error("CCTP_DESTINATION_RECIPIENT_UNSUPPORTED");
  return { sourceDomain: BigInt(sourceDomain), nonce: bytes32(bytes, 12), headerSender: bytes32(bytes, 44), finalityThreshold: BigInt(uint32(bytes, 144)), body: `0x${hex(bytes.slice(148))}`, mintRecipientTopic: mintRecipient, amount: amount - fee, fee };
}

function matchesMessageReceived(log: EvmLog, config: CctpEvmDestinationConfig, expected: ExpectedMessage): boolean {
  if (log.address !== config.messageTransmitter || log.topics.length !== 4 || log.topics[0] !== MESSAGE_RECEIVED_TOPIC || log.topics[2] !== expected.nonce || quantityWord(log.topics[3]) !== expected.finalityThreshold) return false;
  try {
    const decoded = decodeMessageReceivedData(log.data);
    return decoded.sourceDomain === expected.sourceDomain && decoded.sender === expected.headerSender && decoded.messageBody === expected.body;
  } catch { return false; }
}

function decodeMessageReceivedData(data: string): { sourceDomain: bigint; sender: string; messageBody: string } {
  const bytes = hexBytes(data);
  if (bytes.length < 128 || bytes.length % 32 !== 0 || uint256(bytes, 64) !== 96n) throw new Error("CCTP_DESTINATION_MESSAGE_LOG_INVALID");
  const length = uint256(bytes, 96);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CCTP_DESTINATION_MESSAGE_LOG_INVALID");
  const size = Number(length), padded = Math.ceil(size / 32) * 32;
  if (bytes.length !== 128 + padded || bytes.slice(128 + size).some((byte) => byte !== 0)) throw new Error("CCTP_DESTINATION_MESSAGE_LOG_INVALID");
  return { sourceDomain: uint256(bytes, 0), sender: bytes32(bytes, 32), messageBody: `0x${hex(bytes.slice(128, 128 + size))}` };
}

function matchesMintAndWithdraw(log: EvmLog, config: CctpEvmDestinationConfig, expected: ExpectedMessage): boolean {
  if (log.address !== config.tokenMessenger || log.topics.length !== 3 || log.topics[0] !== MINT_AND_WITHDRAW_TOPIC || log.topics[1] !== expected.mintRecipientTopic || log.topics[2] !== addressTopic(config.mintToken)) return false;
  try { const bytes = hexBytes(log.data); return bytes.length === 64 && uint256(bytes, 0) === expected.amount && uint256(bytes, 32) === expected.fee; } catch { return false; }
}

function createReader(endpoint: string, fetchImpl: typeof fetch, timeoutMs: number): CctpEvmDestinationReader {
  let requestId = 0;
  const request = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const id = ++requestId, controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: controller.signal });
      if (!response.ok) throw new Error("CCTP_DESTINATION_RPC_HTTP_FAILED");
      const payload = JSON.parse(await readBounded(response)) as Record<string, unknown>;
      if (!isPlainObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== id || payload.error !== undefined || !Object.prototype.hasOwnProperty.call(payload, "result")) throw new Error("CCTP_DESTINATION_RPC_RESPONSE_INVALID");
      return payload.result;
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") throw new Error("CCTP_DESTINATION_RPC_TIMEOUT");
      throw reason;
    } finally { clearTimeout(timeout); }
  };
  return { id: new URL(endpoint).hostname.toLowerCase(), chainId: async () => quantityBigInt(await request("eth_chainId", [])), blockNumber: async () => quantityNumber(await request("eth_blockNumber", [])), receipt: async (hash) => { if (!isHash(hash)) throw new Error("CCTP_DESTINATION_TRANSACTION_HASH_INVALID"); const value = await request("eth_getTransactionReceipt", [hash]); return value === null ? null : parseReceipt(value); } };
}

function parseReceipt(value: unknown): EvmReceipt {
  if (!isPlainObject(value) || !Array.isArray(value.logs) || value.logs.length > 256) throw new Error("CCTP_DESTINATION_RPC_RECEIPT_INVALID");
  const status = quantityNumber(value.status); if (status !== 0 && status !== 1) throw new Error("CCTP_DESTINATION_RPC_RECEIPT_INVALID");
  const transactionHash = requiredHash(value.transactionHash), blockNumber = quantityNumber(value.blockNumber), blockHash = requiredHash(value.blockHash);
  return { transactionHash, status, blockNumber, blockHash, logs: value.logs.map((item) => parseLog(item, transactionHash, blockNumber, blockHash)) };
}

function parseLog(value: unknown, transactionHash: string, blockNumber: number, blockHash: string): EvmLog {
  if (!isPlainObject(value) || typeof value.address !== "string" || !/^0x[0-9a-f]{40}$/i.test(value.address) || !Array.isArray(value.topics) || value.topics.length > 4 || value.topics.some((topic) => typeof topic !== "string" || !isHash(topic)) || !isData(value.data) || value.removed !== false) throw new Error("CCTP_DESTINATION_RPC_LOG_INVALID");
  if (requiredHash(value.transactionHash) !== transactionHash || quantityNumber(value.blockNumber) !== blockNumber || requiredHash(value.blockHash) !== blockHash) throw new Error("CCTP_DESTINATION_RPC_LOG_INVALID");
  return { address: value.address.toLowerCase(), topics: value.topics.map((topic) => String(topic).toLowerCase()), data: String(value.data).toLowerCase(), transactionHash, blockNumber, blockHash, logIndex: quantityNumber(value.logIndex) };
}

function assertReceipt(receipt: EvmReceipt, transactionHash: string, head: number): void {
  if (!isHash(receipt.transactionHash) || receipt.transactionHash !== transactionHash.toLowerCase() || (receipt.status !== 0 && receipt.status !== 1) || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || receipt.blockNumber > head || !isHash(receipt.blockHash) || !Array.isArray(receipt.logs) || receipt.logs.length > 256) throw new Error("CCTP_DESTINATION_RECEIPT_INVALID");
  receipt.logs.forEach((log) => { if (!/^0x[0-9a-f]{40}$/.test(log.address) || !Array.isArray(log.topics) || log.topics.length > 4 || log.topics.some((topic) => !isHash(topic)) || !isData(log.data) || log.transactionHash !== receipt.transactionHash || log.blockNumber !== receipt.blockNumber || log.blockHash !== receipt.blockHash || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) throw new Error("CCTP_DESTINATION_RECEIPT_INVALID"); });
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("CCTP_DESTINATION_RPC_RESPONSE_TOO_LARGE");
  if (!response.body) { const text = await response.text(); if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("CCTP_DESTINATION_RPC_RESPONSE_TOO_LARGE"); return text; }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let total = 0, text = "";
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("CCTP_DESTINATION_RPC_RESPONSE_TOO_LARGE"); } text += decoder.decode(value, { stream: true }); }
  return text + decoder.decode();
}

function quantityBigInt(value: unknown): bigint { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error("CCTP_DESTINATION_RPC_QUANTITY_INVALID"); return BigInt(value); }
function quantityNumber(value: unknown): number { const parsed = quantityBigInt(value); if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CCTP_DESTINATION_RPC_QUANTITY_INVALID"); return Number(parsed); }
function requiredHash(value: unknown): string { if (typeof value !== "string" || !isHash(value)) throw new Error("CCTP_DESTINATION_RPC_HASH_INVALID"); return value.toLowerCase(); }
function addressTopic(address: string): string { return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`; }
function quantityWord(value: string): bigint { return BigInt(value); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value); }
function isData(value: unknown): value is string { return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value); }
function hexBytes(value: string): Uint8Array { const output = new Uint8Array((value.length - 2) / 2); for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16); return output; }
function uint32(bytes: Uint8Array, offset: number): number { if (offset < 0 || offset + 4 > bytes.length) throw new Error("CCTP_DESTINATION_MESSAGE_INVALID"); return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false); }
function uint256(bytes: Uint8Array, offset: number): bigint { if (offset < 0 || offset + 32 > bytes.length) throw new Error("CCTP_DESTINATION_MESSAGE_INVALID"); return BigInt(`0x${hex(bytes.slice(offset, offset + 32))}`); }
function bytes32(bytes: Uint8Array, offset: number): string { if (offset < 0 || offset + 32 > bytes.length) throw new Error("CCTP_DESTINATION_MESSAGE_INVALID"); return `0x${hex(bytes.slice(offset, offset + 32))}`; }
function hex(bytes: Uint8Array): string { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function isPlainObject(value: unknown): value is Record<string, any> { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
