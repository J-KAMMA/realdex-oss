import { Interface, getAddress, keccak256 } from "ethers";
import { ERC20_ABI, ROUTER_ABI } from "../abi";
import { describe, expect, it, vi } from "vitest";
import { executeRouteQuote, quoteRoutes } from "../routing/engine";
import type { RouteQuoteRequest } from "../routing/types";
import { createProviderBindingGrant } from "../wallet/capabilities";
import { createEvmMultiHopAdapter, createEvmMultiHopRouteDescriptor, parseIntermediateTokens, type EvmMultiHopClient, type EvmMultiHopPath } from "./evm-multihop";

const router = getAddress("0x1000000000000000000000000000000000000001");
const poolAB = getAddress("0x2000000000000000000000000000000000000001");
const poolBC = getAddress("0x2000000000000000000000000000000000000002");
const tokenA = getAddress("0x3000000000000000000000000000000000000001");
const tokenB = getAddress("0x3000000000000000000000000000000000000002");
const tokenC = getAddress("0x3000000000000000000000000000000000000003");
const account = getAddress("0x4000000000000000000000000000000000000001");
const routerCode = "0x60006000";
const routerHash = keccak256(routerCode);
const path: EvmMultiHopPath = { chainId: 31337n, router, pools: [poolAB, poolBC], tokens: [tokenA, tokenB, tokenC] };
const route = createEvmMultiHopRouteDescriptor(path);
const paths = new Map([[route.id, path]]);
const request: RouteQuoteRequest = {
  executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000020",
  sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset, amountInBaseUnits: 1_000_000n,
  accountId: `eip155:31337:${account}`, recipient: account, walletCapabilityId: "eip1193", sessionRevision: 2, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: `eip155:31337:${account}`, walletCapabilityId: "eip1193", sessionRevision: 2, expiresAt: Date.now() + 120_000 }), slippageBps: 50
};

function transaction(hash: string, to: string, data: string, nonce: number, wait: () => Promise<{ hash: string; status: number; blockNumber: number; blockHash: string } | null> = vi.fn(async () => ({ hash, status: 1, blockNumber: 91, blockHash: `0x${"f".repeat(64)}` }))) { return { hash, from: account, to, nonce, data, value: 0n, chainId: 31337n, wait }; }

function client(overrides: Partial<EvmMultiHopClient> = {}): EvmMultiHopClient {
  return {
    connectAccount: vi.fn(async () => ({ account, chainId: 31337n })),
    code: vi.fn(async () => routerCode),
    poolTokens: vi.fn(async (pool) => pool === poolAB ? { token0: tokenA, token1: tokenB } : { token0: tokenB, token1: tokenC }),
    quoteExactIn: vi.fn(async () => ({ amountOut: 2_000_000n, tokenOut: tokenC })),
    allowance: vi.fn(async () => 0n),
    blockNumber: vi.fn(async () => 90),
    approveExact: vi.fn(async (token, spender, amount) => transaction(`0x${"a".repeat(64)}`, token, new Interface(ERC20_ABI).encodeFunctionData("approve", [spender, amount]), 1)),
    swapExactIn: vi.fn(async (target, pools, token, amount, minimum, recipient, deadline) => transaction(`0x${"b".repeat(64)}`, target, new Interface(ROUTER_ABI).encodeFunctionData("swapExactIn", [pools, token, amount, minimum, recipient, deadline]), 2)),
    ...overrides
  };
}

describe("EVM atomic multi-hop routing", () => {
  it("normalizes intermediary tokens and rejects unsafe graph sizes", () => {
    expect(parseIntermediateTokens(`${tokenB.toLowerCase()}, ${tokenB}`)).toEqual([tokenB]);
    expect(() => parseIntermediateTokens("not-an-address")).toThrow("EVM_MULTIHOP_TOKEN_INVALID");
    expect(() => parseIntermediateTokens([tokenA, tokenB, tokenC, account, router].join(","))).toThrow("EVM_MULTIHOP_TOKEN_LIMIT_EXCEEDED");
    expect(() => createEvmMultiHopRouteDescriptor({ ...path, pools: [poolAB, poolAB], tokens: [tokenA, tokenB, tokenC] })).toThrow("EVM_MULTIHOP_PATH_CYCLIC");
  });

  it("binds quote, exact router approval, ordered pools, and final minimum output", async () => {
    const fake = client();
    const adapter = createEvmMultiHopAdapter(fake, paths, routerHash);
    const search = await quoteRoutes(request, [route], [adapter]);
    expect(search.rejected).toEqual([]);
    expect(search.quotes[0].minimumOutBaseUnits).toBe(1_990_000n);
    expect(search.quotes[0].authorization).toEqual({ type: "approval", spender: router, amountBaseUnits: 1_000_000n, expiresAt: null });
    const progress: string[] = [];
    const receipt = await executeRouteQuote(route, request, search.quotes[0], [adapter], Date.now(), (value) => progress.push(value.steps.at(-1)?.name ?? ""));
    expect(receipt.state).toBe("confirmed");
    expect(progress).toEqual(["Exact router approval", "Exact router approval", "Atomic 2-hop swap"]);
    expect(fake.approveExact).toHaveBeenCalledWith(tokenA, router, 1_000_000n);
    expect(fake.swapExactIn).toHaveBeenCalledWith(router, [poolAB, poolBC], tokenA, 1_000_000n, 1_990_000n, account, expect.any(Number));
  });

  it("fails closed on router code or pool path changes before quoting", async () => {
    const wrongCode = createEvmMultiHopAdapter(client({ code: async () => "0x6001" }), paths, routerHash);
    expect((await quoteRoutes(request, [route], [wrongCode])).rejected[0].code).toBe("EVM_MULTIHOP_ROUTER_CODE_MISMATCH");
    const wrongPair = createEvmMultiHopAdapter(client({ poolTokens: async () => ({ token0: tokenA, token1: tokenC }) }), paths, routerHash);
    expect((await quoteRoutes(request, [route], [wrongPair])).rejected[0].code).toBe("EVM_MULTIHOP_POOL_PATH_CHANGED");
  });

  it("does not unlock an atomic quote when its submitted receipt is unavailable", async () => {
    let pending!: ReturnType<typeof transaction>;
    const fake = client({ allowance: async () => 1_000_000n, swapExactIn: async (target, pools, token, amount, minimum, recipient, deadline) => pending = transaction(`0x${"c".repeat(64)}`, target, new Interface(ROUTER_ABI).encodeFunctionData("swapExactIn", [pools, token, amount, minimum, recipient, deadline]), 3, vi.fn(async () => null)) });
    const adapter = createEvmMultiHopAdapter(fake, paths, routerHash);
    const changedRequest = { ...request, executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000021", sessionRevision: 8, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: request.accountId, walletCapabilityId: "eip1193", sessionRevision: 8, expiresAt: Date.now() + 120_000 }) };
    const quote = (await quoteRoutes(changedRequest, [route], [adapter])).quotes[0];
    const result = await executeRouteQuote(route, changedRequest, quote, [adapter]);
    expect(result.state).toBe("unknown");
    expect(result.steps.find((step) => step.kind === "swap")).toMatchObject({ state: "unknown", txHash: pending!.hash, evmTransaction: { nonce: 3, observedBeforeBlock: 90 } });
    await expect(executeRouteQuote(route, changedRequest, quote, [adapter])).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
  });
});
