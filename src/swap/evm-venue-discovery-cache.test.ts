import { describe, expect, it } from "vitest";
import { getAddress } from "ethers";
import { createCachingEvmVenueDiscoveryClient, type EvmVenueDiscoveryClient } from "./evm-venue-discovery";

const A = getAddress("0x1111111111111111111111111111111111111111");
const B = getAddress("0x2222222222222222222222222222222222222222");

function counting (overrides: Partial<EvmVenueDiscoveryClient> = {}) {
  const calls = { chainId: 0, code: 0, poolFor: 0, poolFactory: 0, poolTokens: 0 };
  const client: EvmVenueDiscoveryClient = {
    chainId: async () => { calls.chainId++; return 31337n; },
    code: async (address) => { calls.code++; return `0xcode${address.slice(-2)}`; },
    poolFor: async () => { calls.poolFor++; return A; },
    poolFactory: async () => { calls.poolFactory++; return B; },
    poolTokens: async () => { calls.poolTokens++; return { token0: A, token1: B }; },
    ...overrides
  };
  return { calls, client };
}

describe("caching what cannot change during one discovery run", () => {
  it("reads the chain once however often it is asked", async () => {
    const { calls, client } = counting();
    const cached = createCachingEvmVenueDiscoveryClient(client);
    expect(await Promise.all([cached.chainId(), cached.chainId(), cached.chainId()])).toEqual([31337n, 31337n, 31337n]);
    expect(calls.chainId).toBe(1);
  });

  it("reads each address's code once and still answers correctly", async () => {
    const { calls, client } = counting();
    const cached = createCachingEvmVenueDiscoveryClient(client);
    const first = await cached.code(A);
    expect(await cached.code(A)).toBe(first);
    expect(await cached.code(A.toLowerCase())).toBe(first);
    expect(await cached.code(B)).not.toBe(first);
    expect(calls.code).toBe(2);
  });

  it("collapses reads that overlap rather than starting a second one", async () => {
    const { calls, client } = counting();
    const cached = createCachingEvmVenueDiscoveryClient(client);
    await Promise.all([cached.code(A), cached.code(A), cached.code(A)]);
    expect(calls.code).toBe(1);
  });

  it("caches a pool's factory and its pair, which the constructor fixes", async () => {
    const { calls, client } = counting();
    const cached = createCachingEvmVenueDiscoveryClient(client);
    await Promise.all([cached.poolFactory(A), cached.poolFactory(A), cached.poolTokens(A), cached.poolTokens(A)]);
    expect(calls.poolFactory).toBe(1);
    expect(calls.poolTokens).toBe(1);
  });

  it("asks for a pool once per factory, pair and tier", async () => {
    const { calls, client } = counting();
    const cached = createCachingEvmVenueDiscoveryClient(client);
    await cached.poolFor(A, A, B, 1);
    await cached.poolFor(A, A, B, 1);
    expect(calls.poolFor).toBe(1);
  });

  it("treats the pair as unordered, because the factory writes both orders", async () => {
    const { calls, client } = counting();
    const cached = createCachingEvmVenueDiscoveryClient(client);
    await cached.poolFor(A, A, B, 1);
    await cached.poolFor(A, B, A, 1);
    expect(calls.poolFor).toBe(1);
  });

  it("keeps tiers apart: the same pair at two rates is two questions", async () => {
    const seen: number[] = [];
    const { client } = counting({ poolFor: async (_factory, _a, _b, fee) => { seen.push(fee); return A; } });
    const cached = createCachingEvmVenueDiscoveryClient(client);
    await cached.poolFor(A, A, B, 1);
    await cached.poolFor(A, A, B, 30);
    expect(seen).toEqual([1, 30]);
  });

  it("keeps factories apart: the same pair on two factories is two questions", async () => {
    const seen: string[] = [];
    const { client } = counting({ poolFor: async (factory) => { seen.push(factory); return A; } });
    const cached = createCachingEvmVenueDiscoveryClient(client);
    await cached.poolFor(A, A, B, 1);
    await cached.poolFor(B, A, B, 1);
    expect(seen).toEqual([A, B]);
  });

  it("forgets a failed pool lookup rather than answering 'none' for the rest of the run", async () => {
    let attempt = 0;
    const { client } = counting({ poolFor: async () => { attempt++; if (attempt === 1) throw new Error("connection reset"); return B; } });
    const cached = createCachingEvmVenueDiscoveryClient(client);
    await expect(cached.poolFor(A, A, B, 1)).rejects.toThrow("connection reset");
    expect(await cached.poolFor(A, A, B, 1)).toBe(B);
  });

  it("forgets a failed read instead of turning it into a verdict", async () => {
    let attempt = 0;
    const { client } = counting({
      code: async () => { attempt++; if (attempt === 1) throw new Error("connection reset"); return "0xok"; }
    });
    const cached = createCachingEvmVenueDiscoveryClient(client);
    await expect(cached.code(A)).rejects.toThrow("connection reset");
    expect(await cached.code(A)).toBe("0xok");
    expect(attempt).toBe(2);
  });

  it("forgets a failed chain read too", async () => {
    let attempt = 0;
    const { client } = counting({
      chainId: async () => { attempt++; if (attempt === 1) throw new Error("connection reset"); return 8453n; }
    });
    const cached = createCachingEvmVenueDiscoveryClient(client);
    await expect(cached.chainId()).rejects.toThrow("connection reset");
    expect(await cached.chainId()).toBe(8453n);
  });
});
