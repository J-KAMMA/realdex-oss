import { Interface } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { ERC20_ABI, POOL_ABI } from "../abi";
import { executeRouteQuote, quoteRoutes } from "../routing/engine";
import type { RouteQuoteRequest } from "../routing/types";
import { createProviderBindingGrant } from "../wallet/capabilities";
import { createEvmLocalAmmAdapter, createLocalAmmRouteDescriptor, type EvmLocalAmmClient } from "./evm-local-amm";

const pool = "0x1000000000000000000000000000000000000001";
const tokenIn = "0x2000000000000000000000000000000000000002";
const tokenOut = "0x3000000000000000000000000000000000000003";
const account = "0x4000000000000000000000000000000000000004";
const route = createLocalAmmRouteDescriptor({ chainId: 31337n, poolAddress: pool, tokenIn, tokenOut });
const request: RouteQuoteRequest = {
  executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000010",
  sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset, amountInBaseUnits: 1_000_000n,
  accountId: `eip155:31337:${account}`, recipient: account, walletCapabilityId: "eip1193", sessionRevision: 3, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: `eip155:31337:${account}`, walletCapabilityId: "eip1193", sessionRevision: 3, expiresAt: Date.now() + 120_000 }), slippageBps: 50
};

function transaction(hash: string, to: string, data: string, nonce: number, wait: () => Promise<{ hash: string; status: number; blockNumber: number; blockHash: string } | null> = vi.fn(async () => ({ hash, status: 1, blockNumber: 91, blockHash: `0x${"f".repeat(64)}` }))) {
  return { hash, from: account, to, nonce, data, value: 0n, chainId: 31337n, wait };
}

function client(overrides: Partial<EvmLocalAmmClient> = {}): EvmLocalAmmClient {
  return {
    connectAccount: vi.fn(async () => ({ account, chainId: 31337n })),
    poolTokens: vi.fn(async () => ({ token0: tokenIn, token1: tokenOut })),
    poolReserves: vi.fn(async () => ({ reserve0: 9_000_000n, reserve1: 9_000_000n })),
    quoteExactIn: vi.fn(async () => 900_000n),
    allowance: vi.fn(async () => 0n),
    blockNumber: vi.fn(async () => 90),
    approveExact: vi.fn(async (token, spender, amount) => transaction(`0x${"a".repeat(64)}`, token, new Interface(ERC20_ABI).encodeFunctionData("approve", [spender, amount]), 1)),
    swapExactIn: vi.fn(async (target, token, amount, minimum, recipient, deadline) => transaction(`0x${"b".repeat(64)}`, target, new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [token, amount, minimum, recipient, deadline]), 2)),
    ...overrides
  };
}

describe("EVM LocalSwap universal adapter", () => {
  it("creates a bound quote with an exact approval and disclosed unpriced gas", async () => {
    const adapter = createEvmLocalAmmAdapter(client());
    const result = await quoteRoutes(request, [route], [adapter]);
    expect(result.rejected).toEqual([]);
    expect(result.quotes[0].minimumOutBaseUnits).toBe(895_500n);
    expect(result.quotes[0].priceImpactBps).toBe(1_000);
    expect(result.quotes[0].authorization).toEqual({ type: "approval", spender: pool, amountBaseUnits: 1_000_000n, expiresAt: null });
    expect(result.quotes[0].unpricedCosts[0]).toContain("Network gas");
    expect(result.quotes[0].executionPreview).toMatchObject({ chainId: "eip155:31337", target: pool, method: "swapExactIn" });
  });

  it("executes approval and swap from the same quote while reporting pending progress", async () => {
    const fake = client();
    const adapter = createEvmLocalAmmAdapter(fake);
    const quote = (await quoteRoutes(request, [route], [adapter])).quotes[0];
    const progress: string[] = [];
    const receipt = await executeRouteQuote(route, request, quote, [adapter], Date.now(), (update) => progress.push(`${update.state}:${update.steps.at(-1)?.state}`));
    expect(receipt.state).toBe("confirmed");
    expect(progress).toEqual(["pending:submitted", "pending:confirmed", "pending:submitted"]);
    expect(fake.approveExact).toHaveBeenCalledWith(tokenIn, pool, 1_000_000n);
    expect(fake.swapExactIn).toHaveBeenCalledWith(pool, tokenIn, 1_000_000n, 895_500n, account, expect.any(Number));
  });

  it("fails closed when the pool pair or wallet account changes", async () => {
    const pairChanged = createEvmLocalAmmAdapter(client({ poolTokens: async () => ({ token0: tokenIn, token1: account }) }));
    expect((await quoteRoutes(request, [route], [pairChanged])).rejected[0].code).toBe("LOCAL_AMM_POOL_PAIR_CHANGED");
    const accountChanged = createEvmLocalAmmAdapter(client({ connectAccount: async () => ({ account: pool, chainId: 31337n }) }));
    expect((await quoteRoutes(request, [route], [accountChanged])).rejected[0].code).toBe("WALLET_ACCOUNT_CHANGED");
  });

  it("returns a failed receipt for wallet rejection so no swap is submitted", async () => {
    const fake = client({ approveExact: async () => { throw Object.assign(new Error("untrusted provider payload ".repeat(100)), { code: "ACTION_REJECTED" }); } });
    const adapter = createEvmLocalAmmAdapter(fake);
    const changedRequest = { ...request, executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000011", sessionRevision: 4, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: request.accountId, walletCapabilityId: "eip1193", sessionRevision: 4, expiresAt: Date.now() + 120_000 }) };
    const quote = (await quoteRoutes(changedRequest, [route], [adapter])).quotes[0];
    const receipt = await executeRouteQuote(route, changedRequest, quote, [adapter]);
    expect(receipt.state).toBe("failed");
    expect(receipt.steps.at(-1)?.errorMessage).toBe("Wallet rejected the request.");
    expect(fake.swapExactIn).not.toHaveBeenCalled();
  });

  it.each(["RPC access denied after broadcast", "transport rejected response", "upstream text 4001", "ACTION_REJECTED"])("does not treat ambiguous error text as no-send proof: %s", async message => {
    const fake = client({ allowance: async () => 1_000_000n, swapExactIn: vi.fn(async () => { throw new Error(message); }) });
    const adapter = createEvmLocalAmmAdapter(fake);
    const quote = await adapter.quote(route, request);
    await expect(adapter.execute(route, request, quote)).rejects.toThrow(message);
    expect(fake.swapExactIn).toHaveBeenCalledOnce();
  });

  it("keeps the duplicate guard when a submitted swap receipt is unavailable", async () => {
    let pending!: ReturnType<typeof transaction>;
    const fake = client({ allowance: async () => 1_000_000n, swapExactIn: async (target, token, amount, minimum, recipient, deadline) => pending = transaction(`0x${"c".repeat(64)}`, target, new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [token, amount, minimum, recipient, deadline]), 3, vi.fn(async () => null)) });
    const adapter = createEvmLocalAmmAdapter(fake);
    const changedRequest = { ...request, executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000012", sessionRevision: 9, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: request.accountId, walletCapabilityId: "eip1193", sessionRevision: 9, expiresAt: Date.now() + 120_000 }) };
    const quote = (await quoteRoutes(changedRequest, [route], [adapter])).quotes[0];
    const result = await executeRouteQuote(route, changedRequest, quote, [adapter]);
    expect(result.state).toBe("unknown");
    expect(result.steps.find((step) => step.kind === "swap")).toMatchObject({ state: "unknown", txHash: pending!.hash, evmTransaction: { nonce: 3, observedBeforeBlock: 90 } });
    await expect(executeRouteQuote(route, changedRequest, quote, [adapter])).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
  });
});
