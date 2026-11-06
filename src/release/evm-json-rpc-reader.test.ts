import { describe, expect, it, vi } from "vitest";
import { assertDistinctPublicRpcEndpoints, createPublicJsonRpcDeploymentReader, normalizePublicRpcEndpoint } from "./evm-json-rpc-reader";

function rpcResponse(result: unknown, id = 1) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("public EVM JSON-RPC deployment reader", () => {
  it("accepts only public HTTPS endpoints without URL credentials or query material", () => {
    expect(normalizePublicRpcEndpoint("https://rpc-a.example.org/base")).toBe("https://rpc-a.example.org/base");
    for (const endpoint of ["http://rpc.example.org", "https://user:pass@rpc.example.org", "https://rpc.example.org/?key=secret", "https://localhost", "https://127.0.0.1", "https://192.168.1.2", "https://[::1]"]) {
      expect(() => normalizePublicRpcEndpoint(endpoint)).toThrow("DEPLOYMENT_RPC_URL_NOT_PUBLIC");
    }
  });

  it("requires distinct endpoint hosts for the observation quorum", () => {
    expect(assertDistinctPublicRpcEndpoints(["https://rpc-a.example.org", "https://rpc-b.example.org"])).toHaveLength(2);
    expect(() => assertDistinctPublicRpcEndpoints(["https://rpc.example.org/a", "https://rpc.example.org/b"])).toThrow("DEPLOYMENT_RPC_ENDPOINTS_NOT_INDEPENDENT");
  });

  it("uses read-only JSON-RPC methods and omits credentials and referrer", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      const results: Record<string, unknown> = {
        eth_chainId: "0x14a34",
        eth_blockNumber: "0x78",
        eth_getCode: "0x6000",
        eth_getTransactionReceipt: { status: "0x1", contractAddress: "0x1111111111111111111111111111111111111111", blockNumber: "0x64" }
      };
      return rpcResponse(results[body.method], body.id);
    });
    const reader = createPublicJsonRpcDeploymentReader("https://rpc.example.org", fetchMock as typeof fetch);
    await expect(reader.chainId()).resolves.toBe(84532n);
    await expect(reader.blockNumber()).resolves.toBe(120);
    await expect(reader.code("0x1111111111111111111111111111111111111111")).resolves.toBe("0x6000");
    await expect(reader.deploymentReceipt(`0x${"a".repeat(64)}`)).resolves.toEqual({ status: "success", contractAddress: "0x1111111111111111111111111111111111111111", blockNumber: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("omit");
      expect(init?.referrerPolicy).toBe("no-referrer");
      expect(["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_getTransactionReceipt"]).toContain(JSON.parse(String(init?.body)).method);
    }
  });

  it("rejects mismatched ids, RPC errors, malformed quantities, and malformed receipts", async () => {
    const mismatched = createPublicJsonRpcDeploymentReader("https://rpc.example.org", async () => rpcResponse("0x1", 999));
    await expect(mismatched.chainId()).rejects.toThrow("DEPLOYMENT_RPC_RESPONSE_INVALID");
    const badQuantity = createPublicJsonRpcDeploymentReader("https://rpc.example.org", async () => rpcResponse("84532"));
    await expect(badQuantity.chainId()).rejects.toThrow("DEPLOYMENT_RPC_QUANTITY_INVALID");
    const badReceipt = createPublicJsonRpcDeploymentReader("https://rpc.example.org", async () => rpcResponse({ status: "0x2", contractAddress: null, blockNumber: "0x1" }));
    await expect(badReceipt.deploymentReceipt(`0x${"a".repeat(64)}`)).rejects.toThrow("DEPLOYMENT_RPC_RECEIPT_INVALID");
  });

  it("times out without retrying or inferring a result", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const reader = createPublicJsonRpcDeploymentReader("https://rpc.example.org", fetchMock as typeof fetch, 5);
    await expect(reader.chainId()).rejects.toThrow("DEPLOYMENT_RPC_TIMEOUT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes through supported read methods with bounded credential-free fetch options", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      return rpcResponse({ method: body.method, params: body.params }, body.id);
    });
    const reader = createPublicJsonRpcDeploymentReader("https://rpc.example.org", fetchMock as typeof fetch, 25);
    const hash = `0x${"a".repeat(64)}`;

    await expect(reader.send("eth_chainId", [])).resolves.toEqual({ method: "eth_chainId", params: [] });
    await expect(reader.send("eth_blockNumber", [])).resolves.toEqual({ method: "eth_blockNumber", params: [] });
    await expect(reader.send("eth_getTransactionByHash", [hash])).resolves.toEqual({ method: "eth_getTransactionByHash", params: [hash] });
    await expect(reader.send("eth_getTransactionReceipt", [hash])).resolves.toEqual({ method: "eth_getTransactionReceipt", params: [hash] });
    await expect(reader.send("eth_getBlockByNumber", ["0x2a", false])).resolves.toEqual({ method: "eth_getBlockByNumber", params: ["0x2a", false] });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://rpc.example.org/");
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("omit");
      expect(init?.referrerPolicy).toBe("no-referrer");
      expect(init?.cache).toBe("no-store");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(String(init?.body).length).toBeLessThan(1_000_000);
    }
  });

  it("rejects writes, unknown methods, and malformed read parameters before fetch", async () => {
    const fetchMock = vi.fn(async () => rpcResponse(null));
    const reader = createPublicJsonRpcDeploymentReader("https://rpc.example.org", fetchMock as typeof fetch);
    const hash = `0x${"a".repeat(64)}`;
    const invalidCalls: Array<[string, unknown[]]> = [
      ["eth_sendRawTransaction", []],
      ["eth_unknown", []],
      ["eth_chainId", [null]],
      ["eth_blockNumber", ["0x0"]],
      ["eth_getTransactionByHash", [`0x${"a".repeat(63)}`]],
      ["eth_getTransactionReceipt", [hash, "latest"]],
      ["eth_getBlockByNumber", ["0x00", false]],
      ["eth_getBlockByNumber", ["0x2a", true]],
      ["eth_getBlockByNumber", ["0x2a"]]
    ];

    for (const [method, params] of invalidCalls) {
      await expect(reader.send(method, params)).rejects.toThrow("DEPLOYMENT_RPC_READ_METHOD_INVALID");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("protects send from mismatched payload ids, timeout, and oversized responses", async () => {
    const mismatched = createPublicJsonRpcDeploymentReader("https://rpc.example.org", async () => rpcResponse("0x1", 999));
    await expect(mismatched.send("eth_chainId", [])).rejects.toThrow("DEPLOYMENT_RPC_RESPONSE_INVALID");

    const timeoutFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const timeoutReader = createPublicJsonRpcDeploymentReader("https://rpc.example.org", timeoutFetch as typeof fetch, 5);
    await expect(timeoutReader.send("eth_blockNumber", [])).rejects.toThrow("DEPLOYMENT_RPC_TIMEOUT");
    expect(timeoutFetch).toHaveBeenCalledTimes(1);

    const oversizedFetch = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": "1000001", "content-type": "application/json" }
    }));
    const oversizedReader = createPublicJsonRpcDeploymentReader("https://rpc.example.org", oversizedFetch as typeof fetch);
    await expect(oversizedReader.send("eth_chainId", [])).rejects.toThrow("DEPLOYMENT_RPC_RESPONSE_TOO_LARGE");
    expect(oversizedFetch).toHaveBeenCalledTimes(1);
  });
});
