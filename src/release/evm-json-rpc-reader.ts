import type { EvmDeploymentReader, EvmDeploymentReceipt } from "./evm-public-testnet";

type FetchLike = typeof fetch;

const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const MAX_RPC_RESPONSE_BYTES = 1_000_000;

export function normalizePublicRpcEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("DEPLOYMENT_RPC_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("DEPLOYMENT_RPC_URL_NOT_PUBLIC");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || isPrivateIpv4(hostname) || hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) throw new Error("DEPLOYMENT_RPC_URL_NOT_PUBLIC");
  return url.toString();
}

export function assertDistinctPublicRpcEndpoints(values: readonly string[]): string[] {
  const endpoints = values.map(normalizePublicRpcEndpoint);
  if (endpoints.length < 2 || endpoints.length > 4) throw new Error("DEPLOYMENT_RPC_QUORUM_INVALID");
  const hosts = endpoints.map((endpoint) => new URL(endpoint).hostname.toLowerCase());
  if (new Set(endpoints).size !== endpoints.length || new Set(hosts).size !== hosts.length) throw new Error("DEPLOYMENT_RPC_ENDPOINTS_NOT_INDEPENDENT");
  return endpoints;
}

export function createPublicJsonRpcDeploymentReader(endpointValue: string, fetchImpl: FetchLike = fetch, timeoutMs = 8_000): EvmDeploymentReader & { call(address: string, data: string): Promise<string>; send(method: string, params: unknown[]): Promise<unknown> } {
  const endpoint = normalizePublicRpcEndpoint(endpointValue);
  const readerId = new URL(endpoint).hostname.toLowerCase();
  let requestId = 0;

  const request = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const id = ++requestId;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) throw new Error("DEPLOYMENT_RPC_HTTP_FAILED");
      const text = await readBoundedResponse(response);
      const payload = JSON.parse(text) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
      if (!payload || typeof payload !== "object" || payload.jsonrpc !== "2.0" || payload.id !== id || payload.error !== undefined || !("result" in payload)) throw new Error("DEPLOYMENT_RPC_RESPONSE_INVALID");
      return payload.result;
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") throw new Error("DEPLOYMENT_RPC_TIMEOUT");
      throw reason;
    } finally { clearTimeout(timeout); }
  };

  return {
    id: readerId,
    // Candidate reconciliation shares the bounded, credential-free read transport.
    // Never expose the private request function as a general RPC/write capability.
    send: async (method, params) => {
      const valid = (method === "eth_chainId" || method === "eth_blockNumber") ? params.length === 0
        : (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") ? params.length === 1 && typeof params[0] === "string" && /^0x[0-9a-f]{64}$/i.test(params[0])
        : method === "eth_getBlockByNumber" && params.length === 2 && typeof params[0] === "string" && HEX_QUANTITY.test(params[0]) && params[1] === false;
      if (!valid) throw new Error("DEPLOYMENT_RPC_READ_METHOD_INVALID");
      return request(method, params);
    },
    chainId: async () => parseRpcBigInt(await request("eth_chainId", [])),
    blockNumber: async () => parseRpcSafeNumber(await request("eth_blockNumber", [])),
    code: async (address) => parseRpcHexData(await request("eth_getCode", [address, "latest"])),
    deploymentReceipt: async (transactionHash) => parseReceipt(await request("eth_getTransactionReceipt", [transactionHash])),
    call: async (address, data) => {
      if (!/^0x[0-9a-f]{40}$/i.test(address) || !/^0x(?:[0-9a-f]{2}){4,256}$/i.test(data)) throw new Error("DEPLOYMENT_RPC_CALL_INVALID");
      return parseRpcHexData(await request("eth_call", [{ to: address, data }, "latest"]));
    }
  };
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RPC_RESPONSE_BYTES) throw new Error("DEPLOYMENT_RPC_RESPONSE_TOO_LARGE");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RPC_RESPONSE_BYTES) throw new Error("DEPLOYMENT_RPC_RESPONSE_TOO_LARGE");
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
    if (total > MAX_RPC_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("DEPLOYMENT_RPC_RESPONSE_TOO_LARGE");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseReceipt(value: unknown): EvmDeploymentReceipt | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DEPLOYMENT_RPC_RECEIPT_INVALID");
  const receipt = value as Record<string, unknown>;
  if (receipt.status !== "0x0" && receipt.status !== "0x1") throw new Error("DEPLOYMENT_RPC_RECEIPT_INVALID");
  if (receipt.contractAddress !== null && (typeof receipt.contractAddress !== "string" || !/^0x[0-9a-f]{40}$/i.test(receipt.contractAddress))) throw new Error("DEPLOYMENT_RPC_RECEIPT_INVALID");
  return { status: receipt.status === "0x1" ? "success" : "failed", contractAddress: receipt.contractAddress as string | null, blockNumber: parseRpcSafeNumber(receipt.blockNumber) };
}

function parseRpcBigInt(value: unknown): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) throw new Error("DEPLOYMENT_RPC_QUANTITY_INVALID");
  return BigInt(value);
}

function parseRpcSafeNumber(value: unknown): number {
  const parsed = parseRpcBigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("DEPLOYMENT_RPC_QUANTITY_INVALID");
  return Number(parsed);
}

function parseRpcHexData(value: unknown): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new Error("DEPLOYMENT_RPC_DATA_INVALID");
  return value.toLowerCase();
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
