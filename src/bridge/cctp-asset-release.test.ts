import { describe, expect, it, vi } from "vitest";
import { BASE_SEPOLIA_CCTP_ASSET, createPinnedBaseCctpAssetReaders, observeBaseCctpAssetIdentity, type CctpAssetIdentityReader } from "./cctp-asset-release";

const PROXY_CODE = "0x60006000";
const IMPLEMENTATION = "0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5";
const IMPLEMENTATION_WORD = `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2)}`;
const IMPLEMENTATION_CODE = "0x60016001";

function abiString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const body = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return `0x${(32).toString(16).padStart(64, "0")}${bytes.length.toString(16).padStart(64, "0")}${body}`;
}

function reader(id: string, overrides: Partial<{ chainId: bigint; block: number; proxyCode: string; implementationWord: string; implementationCode: string; name: string; symbol: string; decimals: number }> = {}): CctpAssetIdentityReader {
  const state = { chainId: 84_532n, block: 10_000, proxyCode: PROXY_CODE, implementationWord: IMPLEMENTATION_WORD, implementationCode: IMPLEMENTATION_CODE, name: "USDC", symbol: "USDC", decimals: 6, ...overrides };
  return {
    id,
    chainId: async () => state.chainId,
    blockNumber: async () => state.block,
    code: async (address) => address.toLowerCase() === BASE_SEPOLIA_CCTP_ASSET.address.toLowerCase() ? state.proxyCode : state.implementationCode,
    storage: async () => state.implementationWord,
    call: async (_address, data) => data === "0x06fdde03" ? abiString(state.name) : data === "0x95d89b41" ? abiString(state.symbol) : `0x${state.decimals.toString(16).padStart(64, "0")}`
  };
}

describe("Base CCTP asset release evidence", () => {
  it("records a two-reader proxy, implementation, and metadata quorum without enabling execution", async () => {
    const evidence = await observeBaseCctpAssetIdentity([reader("base-official"), reader("base-independent", { block: 10_004 })], 1234);
    expect(evidence).toMatchObject({ status: "quorum-observed", observedAt: 1234, executionEnabled: false, releaseApprovalRequired: true });
    expect(evidence.observations).toHaveLength(2);
    expect(evidence.observations[0]).toMatchObject({ name: "USDC", symbol: "USDC", decimals: 6 });
    expect(evidence.observations[0].implementationAddress.toLowerCase()).toBe(IMPLEMENTATION);
  });

  it("rejects missing runtime, metadata changes, head divergence, and reader identity divergence", async () => {
    await expect(observeBaseCctpAssetIdentity([reader("a", { proxyCode: "0x" }), reader("b")])).rejects.toThrow("CCTP_ASSET_PROXY_CODE_MISSING");
    await expect(observeBaseCctpAssetIdentity([reader("a", { name: "USD Coin" }), reader("b", { name: "USD Coin" })])).rejects.toThrow("CCTP_ASSET_METADATA_MISMATCH");
    await expect(observeBaseCctpAssetIdentity([reader("a", { block: 100 }), reader("b", { block: 113 })])).rejects.toThrow("CCTP_ASSET_RPC_HEAD_DIVERGED");
    await expect(observeBaseCctpAssetIdentity([reader("a"), reader("b", { implementationCode: "0x60026002" })])).rejects.toThrow("CCTP_ASSET_RPC_IDENTITY_DIVERGED");
  });

  it("uses only bounded read-only JSON-RPC methods on the pinned independent hosts", async () => {
    const calls: Array<{ url: string; init: RequestInit; method: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      calls.push({ url: String(input), init: init!, method: body.method });
      const result = body.method === "eth_chainId" ? "0x14a34"
        : body.method === "eth_blockNumber" ? "0x2710"
        : body.method === "eth_getStorageAt" ? IMPLEMENTATION_WORD
        : body.method === "eth_call" ? ((body.params[0] as { data: string }).data === "0x313ce567" ? `0x${"6".padStart(64, "0")}` : abiString("USDC"))
        : String(body.params[0]).toLowerCase() === BASE_SEPOLIA_CCTP_ASSET.address.toLowerCase() ? PROXY_CODE : IMPLEMENTATION_CODE;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const evidence = await observeBaseCctpAssetIdentity(createPinnedBaseCctpAssetReaders(fetchMock as typeof fetch));
    expect(evidence.executionEnabled).toBe(false);
    expect(new Set(calls.map((item) => new URL(item.url).hostname))).toEqual(new Set(["sepolia.base.org", "base-sepolia-rpc.publicnode.com"]));
    expect(new Set(calls.map((item) => item.method))).toEqual(new Set(["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_getStorageAt", "eth_call"]));
    expect(calls.every((item) => item.init.credentials === "omit" && item.init.referrerPolicy === "no-referrer" && item.init.cache === "no-store")).toBe(true);
  });
});
