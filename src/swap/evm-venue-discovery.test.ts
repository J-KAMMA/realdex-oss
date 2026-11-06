import { Interface, ZeroAddress, getAddress, keccak256 } from "ethers";
import { POOL_ABI } from "../abi";
import { describe, expect, it, vi } from "vitest";
import { executeRouteQuote, quoteRoutes } from "../routing/engine";
import type { RouteQuoteRequest } from "../routing/types";
import { createProviderBindingGrant } from "../wallet/capabilities";
import { createEvmLocalAmmAdapter, type EvmLocalAmmClient } from "./evm-local-amm";
import {
  configuredLocalAmmVenues, discoverLocalAmmVenues,
  type EvmLocalAmmVenue, type EvmVenueDiscoveryClient
} from "./evm-venue-discovery";

const factoryA = getAddress("0x1000000000000000000000000000000000000001");
const factoryB = getAddress("0x1000000000000000000000000000000000000002");
const poolA = getAddress("0x2000000000000000000000000000000000000001");
const poolB = getAddress("0x2000000000000000000000000000000000000002");
const tokenIn = getAddress("0x3000000000000000000000000000000000000001");
const tokenOut = getAddress("0x3000000000000000000000000000000000000002");
const factoryCode = "0x60006000";
const factoryCodeHash = keccak256(factoryCode);

function venue(id: string, factoryAddress: string): EvmLocalAmmVenue {
  return { id, label: id, chainId: 31337n, factoryAddress, factoryRuntimeCodeHash: factoryCodeHash, feeBasisPoints: 1, revision: 1, evidenceUrls: ["https://example.invalid/venue"] };
}

function client(overrides: Partial<EvmVenueDiscoveryClient> = {}): EvmVenueDiscoveryClient {
  const pools = new Map([[factoryA, poolA], [factoryB, poolB]]);
  const factories = new Map([[poolA, factoryA], [poolB, factoryB]]);
  return {
    chainId: async () => 31337n,
    code: async (address) => pools.has(getAddress(address)) ? factoryCode : "0x6001",
    poolFor: async (factory) => pools.get(getAddress(factory)) ?? ZeroAddress,
    poolFactory: async (pool) => factories.get(getAddress(pool)) ?? ZeroAddress,
    poolTokens: async () => ({ token0: tokenIn, token1: tokenOut }),
    ...overrides
  };
}

describe("EVM LocalSwap venue discovery", () => {
  it("normalizes and deduplicates configured factories", () => {
    const configured = configuredLocalAmmVenues(31337n, factoryA, `${factoryA.toLowerCase()}, ${factoryB}`);
    expect(configured.map((item) => item.factoryAddress)).toEqual([factoryA, factoryB]);
    expect(configured[0].factoryRuntimeCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => configuredLocalAmmVenues(31337n, factoryA, "not-an-address")).toThrow("EVM_VENUE_FACTORY_INVALID");
  });

  it("discovers multiple exact pools only after factory code, origin, and pair verification", async () => {
    const result = await discoverLocalAmmVenues([venue("venue-a", factoryA), venue("venue-b", factoryB)], tokenIn, tokenOut, client());
    expect(result.rejected).toEqual([]);
    expect(result.routes).toHaveLength(2);
    expect(result.routes.map((route) => route.sourceExecutionTarget)).toEqual([poolA, poolB]);
    expect(result.routes.every((route) => route.trustBoundary.includes("exact bundled LocalSwapFactory runtime"))).toBe(true);
    expect(new Set(result.routes.map((route) => route.id)).size).toBe(2);
  });

  it("rejects mismatched factory bytecode without querying a pool", async () => {
    let queried = false;
    const result = await discoverLocalAmmVenues([venue("venue-a", factoryA)], tokenIn, tokenOut, client({
      code: async () => "0x6002",
      poolFor: async () => { queried = true; return poolA; }
    }));
    expect(result.routes).toEqual([]);
    expect(result.rejected[0].code).toBe("EVM_VENUE_FACTORY_CODE_MISMATCH");
    expect(queried).toBe(false);
  });

  it("rejects zero pools, spoofed pool origins, wrong pairs, and duplicate pool targets", async () => {
    const missing = await discoverLocalAmmVenues([venue("missing", factoryA)], tokenIn, tokenOut, client({ poolFor: async () => ZeroAddress }));
    expect(missing.rejected[0].code).toBe("EVM_VENUE_POOL_NOT_FOUND");

    const spoofed = await discoverLocalAmmVenues([venue("spoofed", factoryA)], tokenIn, tokenOut, client({ poolFactory: async () => factoryB }));
    expect(spoofed.rejected[0].code).toBe("EVM_VENUE_POOL_FACTORY_MISMATCH");

    const wrongPair = await discoverLocalAmmVenues([venue("wrong-pair", factoryA)], tokenIn, tokenOut, client({ poolTokens: async () => ({ token0: tokenIn, token1: poolB }) }));
    expect(wrongPair.rejected[0].code).toBe("EVM_VENUE_POOL_PAIR_MISMATCH");

    const duplicate = await discoverLocalAmmVenues([venue("venue-a", factoryA), venue("venue-b", factoryB)], tokenIn, tokenOut, client({ poolFor: async () => poolA, poolFactory: async () => factoryA }));
    expect(duplicate.routes).toHaveLength(1);
    expect(duplicate.rejected[0].code).toBe("EVM_VENUE_DUPLICATE_POOL");
  });

  it("ranks all verified pools and executes the exact route that produced the displayed best quote", async () => {
    const discovery = await discoverLocalAmmVenues([venue("venue-a", factoryA), venue("venue-b", factoryB)], tokenIn, tokenOut, client());
    const account = getAddress("0x4000000000000000000000000000000000000001");
    const swapExactIn = vi.fn(async (target: string, token: string, amount: bigint, minimum: bigint, recipient: string, deadline: number) => {
      const hash = `0x${"d".repeat(64)}`;
      return { hash, from: account, to: target, nonce: 4, data: new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [token, amount, minimum, recipient, deadline]), value: 0n, chainId: 31337n, wait: async () => ({ hash, status: 1, blockNumber: 91, blockHash: `0x${"f".repeat(64)}` }) };
    });
    const ammClient: EvmLocalAmmClient = {
      connectAccount: async () => ({ account, chainId: 31337n }),
      poolTokens: async () => ({ token0: tokenIn, token1: tokenOut }),
      poolReserves: async () => ({ reserve0: 10_000_000n, reserve1: 10_000_000n }),
      quoteExactIn: async (pool) => pool === poolB ? 950_000n : 900_000n,
      allowance: async () => 1_000_000n,
      blockNumber: async () => 90,
      approveExact: async () => { throw new Error("approval should not be needed"); },
      swapExactIn
    };
    const adapter = createEvmLocalAmmAdapter(ammClient);
    const request: RouteQuoteRequest = {
      executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000040",
      sourceAsset: discovery.routes[0].sourceAsset, destinationAsset: discovery.routes[0].destinationAsset,
      amountInBaseUnits: 1_000_000n, accountId: `eip155:31337:${account}`, recipient: account,
      walletCapabilityId: "eip1193", sessionRevision: 1, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: `eip155:31337:${account}`, walletCapabilityId: "eip1193", sessionRevision: 1, expiresAt: Date.now() + 120_000 }), slippageBps: 50
    };
    const search = await quoteRoutes(request, discovery.routes, [adapter]);
    expect(search.quotes).toHaveLength(2);
    expect(search.quotes[0].executionPreview.target).toBe(poolB);
    const selectedRoute = discovery.routes.find((route) => route.id === search.quotes[0].routeId)!;
    const receipt = await executeRouteQuote(selectedRoute, request, search.quotes[0], [adapter]);
    expect(receipt.state).toBe("confirmed");
    expect(swapExactIn).toHaveBeenCalledWith(poolB, tokenIn, 1_000_000n, 945_250n, account, expect.any(Number));
  });
});
