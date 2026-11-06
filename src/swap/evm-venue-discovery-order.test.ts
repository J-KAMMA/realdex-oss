import { ZeroAddress, getAddress, keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import { discoverLocalAmmVenues, type EvmLocalAmmVenue, type EvmVenueDiscoveryClient } from "./evm-venue-discovery";

// Discovery reads every venue at once. Everything that decides *which* answer the
// caller sees still has to depend on the configured order, because the screen
// shows `rejected[0]` when nothing is executable and keeps the first of two
// venues that resolve to one pool. These pin that.

const factoryA = getAddress("0x1000000000000000000000000000000000000001");
const factoryB = getAddress("0x1000000000000000000000000000000000000002");
const factoryC = getAddress("0x1000000000000000000000000000000000000003");
const shared = getAddress("0x2000000000000000000000000000000000000009");
const tokenIn = getAddress("0x3000000000000000000000000000000000000001");
const tokenOut = getAddress("0x3000000000000000000000000000000000000002");
const factoryCode = "0x60006000";
const factoryCodeHash = keccak256(factoryCode);

function venue (id: string, factoryAddress: string, feeBasisPoints = 1): EvmLocalAmmVenue {
  return { id, label: id, chainId: 31337n, factoryAddress, factoryRuntimeCodeHash: factoryCodeHash, feeBasisPoints, revision: 1, evidenceUrls: ["https://example.invalid/venue"] };
}

/** Answers slowly and out of order, so a result that depended on timing would show. */
function staggered (poolByFactory: Map<string, string>, delayByFactory: Map<string, number> = new Map(), owner = factoryA): EvmVenueDiscoveryClient & { concurrentPeak: () => number } {
  let inFlight = 0;
  let peak = 0;
  const wait = async (factory: string) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, delayByFactory.get(factory) ?? 5));
    inFlight--;
  };
  return {
    chainId: async () => 31337n,
    code: async (address) => (getAddress(address) === shared || [...poolByFactory.values()].includes(getAddress(address)) ? "0x6001" : factoryCode),
    poolFor: async (factory) => { await wait(getAddress(factory)); return poolByFactory.get(getAddress(factory)) ?? ZeroAddress; },
    poolFactory: async () => owner,
    poolTokens: async () => ({ token0: tokenIn, token1: tokenOut }),
    concurrentPeak: () => peak
  };
}

describe("reading venues together without changing what the caller sees", () => {
  it("issues the venue reads at the same time rather than one after another", async () => {
    const client = staggered(new Map([[factoryA, shared], [factoryB, shared], [factoryC, shared]]));
    await discoverLocalAmmVenues([venue("venue-a", factoryA), venue("venue-b", factoryB), venue("venue-c", factoryC)], tokenIn, tokenOut, client);
    expect(client.concurrentPeak()).toBe(3);
  });

  it("keeps the first venue that reaches a shared pool, however the reads land", async () => {
    // The first venue configured is answered last, so a result decided by arrival
    // order would keep the wrong one.
    const client = staggered(
      new Map([[factoryA, shared], [factoryB, shared]]),
      new Map([[factoryA, 40], [factoryB, 1]])
    );
    const result = await discoverLocalAmmVenues([venue("venue-a", factoryA), venue("venue-b", factoryB)], tokenIn, tokenOut, client);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].id).toContain("venue-a");
    expect(result.rejected).toEqual([{ venueId: "venue-b", code: "EVM_VENUE_DUPLICATE_POOL", detail: undefined }]);
  });

  it("reports rejections in the configured order, which is the one the screen reads first", async () => {
    const client = staggered(
      new Map([[factoryB, shared]]),
      new Map([[factoryA, 30], [factoryB, 1], [factoryC, 1]]),
      factoryB
    );
    const result = await discoverLocalAmmVenues(
      [venue("venue-a", factoryA), venue("venue-c", factoryC), venue("venue-b", factoryB)],
      tokenIn, tokenOut, client
    );

    expect(result.rejected.map(item => item.venueId)).toEqual(["venue-a", "venue-c"]);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].id).toContain("venue-b");
  });

  it("still refuses a second venue on the same factory and tier before reading anything", async () => {
    let reads = 0;
    const client = staggered(new Map([[factoryA, shared]]));
    const counted: EvmVenueDiscoveryClient = { ...client, poolFor: async (factory, a, b, fee) => { reads++; return client.poolFor(factory, a, b, fee); } };
    const result = await discoverLocalAmmVenues([venue("venue-a", factoryA), venue("venue-again", factoryA)], tokenIn, tokenOut, counted);
    expect(reads).toBe(1);
    expect(result.rejected.map(item => item.code)).toEqual(["EVM_VENUE_DUPLICATE_FACTORY"]);
  });

  it("keeps a malformed venue out of the reads and reports it in place", async () => {
    const client = staggered(new Map([[factoryA, shared]]));
    const broken = { ...venue("venue-broken", factoryA, 30), evidenceUrls: [] };
    const result = await discoverLocalAmmVenues([broken, venue("venue-a", factoryA)], tokenIn, tokenOut, client);
    expect(result.rejected[0].venueId).toBe("venue-broken");
    expect(result.rejected[0].code).toBe("EVM_VENUE_EVIDENCE_INVALID");
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].id).toContain("venue-a");
  });
});
