import { describe, expect, it } from "vitest";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import {
  BUNDLED_LOCAL_AMM_FACTORY_CODE_HASH,
  configuredLocalAmmVenues,
  discoverLocalAmmVenues,
  formatFeeTier,
  parseFeeBasisPointTiers
} from "./evm-venue-discovery";

// A pair can trade at several fee tiers at once, each tier a separate pool at a
// separate address. That is how the fee "changes" in a contract nobody owns, so it
// has to be reachable from configuration. It was not: a venue was identified by its
// factory alone, the tier was hardcoded to 1, and a second venue on the same factory
// was rejected as EVM_VENUE_DUPLICATE_FACTORY. These pin the fix.

// The bundled factory hash is the real one, so a fake client cannot produce code
// that matches it. Discovery is given venues whose hash matches the fake code; the
// bundled value is asserted separately, on what configuration actually builds.
const FACTORY_CODE = "0xfeed";
const FACTORY_CODE_HASH = keccak256(FACTORY_CODE);
const withFakeCode = (venues: ReturnType<typeof configuredLocalAmmVenues>) => venues.map((venue) => ({ ...venue, factoryRuntimeCodeHash: FACTORY_CODE_HASH }));
const FACTORY_A = getAddress("0x1111111111111111111111111111111111111111");
const FACTORY_B = getAddress("0x2222222222222222222222222222222222222222");
const AMBR = getAddress("0x3333333333333333333333333333333333333333");
const JADE = getAddress("0x4444444444444444444444444444444444444444");

// One pool address per (factory, tier), the way the factory's salt makes it.
const poolFor = (factory: string, fee: number) =>
  getAddress(`0x${keccak256(toUtf8Bytes(`${factory.toLowerCase()}:${fee}`)).slice(-40)}`);

function client(available: readonly number[]) {
  return {
    chainId: async () => 31337n,
    code: async (address: string) => (address === FACTORY_A || address === FACTORY_B ? FACTORY_CODE : "0xbeef"),
    poolFor: async (factory: string, _a: string, _b: string, fee: number) =>
      available.includes(fee) ? poolFor(factory, fee) : "0x0000000000000000000000000000000000000000",
    poolFactory: async (pool: string) => (pool === poolFor(FACTORY_B, 30) ? FACTORY_B : FACTORY_A),
    poolTokens: async () => ({ token0: AMBR, token1: JADE })
  };
}

describe("fee tiers are configurable", () => {
  it("reads a tier list, rejecting anything the pool would reject anyway", () => {
    expect(parseFeeBasisPointTiers("1, 5 30")).toEqual([1, 5, 30]);
    expect(parseFeeBasisPointTiers("30,30,1")).toEqual([30, 1]);
    expect(parseFeeBasisPointTiers("")).toEqual([1]);
    // The pool's own bounds are 1..100. A tier outside them can only ever resolve
    // to a pool that does not exist, so it is refused with a reason.
    for (const bad of ["0", "101", "-1", "1.5", "abc"]) {
      expect(() => parseFeeBasisPointTiers(bad)).toThrow("EVM_VENUE_FEE_INVALID");
    }
  });

  it("builds one venue per factory and tier, each with a distinct id", () => {
    const venues = configuredLocalAmmVenues(31337n, FACTORY_A, FACTORY_B, "1, 30");
    expect(venues).toHaveLength(4);
    expect(new Set(venues.map((venue) => venue.id)).size).toBe(4);
    expect(venues.filter((venue) => venue.factoryAddress === FACTORY_A).map((venue) => venue.feeBasisPoints)).toEqual([1, 30]);
    // The label has to name the tier, or two rows on screen look identical.
    for (const venue of venues) expect(venue.label).toContain(formatFeeTier(venue.feeBasisPoints));
    for (const venue of venues) expect(venue.factoryRuntimeCodeHash).toBe(BUNDLED_LOCAL_AMM_FACTORY_CODE_HASH);
  });

  it("defaults to the single tier v0.1 shipped", () => {
    const venues = configuredLocalAmmVenues(31337n, FACTORY_A, "");
    expect(venues).toHaveLength(1);
    expect(venues[0].feeBasisPoints).toBe(1);
  });

  it("counts the limit in venues, not factories", () => {
    const many = Array.from({ length: 17 }, (_, index) => `0x${String(index + 1).padStart(40, "0")}`).join(",");
    expect(() => configuredLocalAmmVenues(31337n, FACTORY_A, many, "1, 30")).toThrow("EVM_VENUE_LIMIT_EXCEEDED");
  });

  it("discovers both tiers of one factory as two separate pools", async () => {
    const venues = configuredLocalAmmVenues(31337n, FACTORY_A, "", "1, 30");
    const result = await discoverLocalAmmVenues(withFakeCode(venues), AMBR, JADE, client([1, 30]));
    expect(result.rejected).toEqual([]);
    expect(result.routes).toHaveLength(2);
    const targets = result.routes.map((route) => getAddress(route.sourceExecutionTarget));
    expect(new Set(targets).size).toBe(2);
    expect(targets).toContain(poolFor(FACTORY_A, 1));
    expect(targets).toContain(poolFor(FACTORY_A, 30));
  });

  it("reports a tier with no pool without discarding the tier that has one", async () => {
    const venues = configuredLocalAmmVenues(31337n, FACTORY_A, "", "1, 30");
    const result = await discoverLocalAmmVenues(withFakeCode(venues), AMBR, JADE, client([1]));
    expect(result.routes).toHaveLength(1);
    expect(getAddress(result.routes[0].sourceExecutionTarget)).toBe(poolFor(FACTORY_A, 1));
    expect(result.rejected).toEqual([{ venueId: venues[1].id, code: "EVM_VENUE_POOL_NOT_FOUND", detail: undefined }]);
  });

  it("still rejects the same tier on the same factory twice", async () => {
    const venues = configuredLocalAmmVenues(31337n, FACTORY_A, "", "1");
    const result = await discoverLocalAmmVenues(withFakeCode([venues[0], { ...venues[0], id: `${venues[0].id}.copy` }]), AMBR, JADE, client([1]));
    expect(result.routes).toHaveLength(1);
    expect(result.rejected[0].code).toBe("EVM_VENUE_DUPLICATE_FACTORY");
  });

  it("refuses a venue whose tier the pool contract could never accept", async () => {
    const [venue] = configuredLocalAmmVenues(31337n, FACTORY_A, "", "1");
    const result = await discoverLocalAmmVenues(withFakeCode([{ ...venue, feeBasisPoints: 0 }]), AMBR, JADE, client([1]));
    expect(result.routes).toEqual([]);
    expect(result.rejected[0].code).toBe("EVM_VENUE_FEE_INVALID");
  });
});
