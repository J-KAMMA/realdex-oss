import { describe, expect, it } from "vitest";
import { getAddress } from "ethers";
import { readPoolTiers, type PoolTierReader } from "./read-pool-tiers";

const A = getAddress("0x1111111111111111111111111111111111111111");
const B = getAddress("0x2222222222222222222222222222222222222222");
const C = getAddress("0x3333333333333333333333333333333333333333");
const pool = (n: number) => getAddress(`0x${String(n).padStart(40, "0")}`);
const one = (value: string) => BigInt(value) * 10n ** 18n;

function reader (pools: Array<{ address: string; token0: string; token1: string; fee: number; factory?: string }>): PoolTierReader {
  return {
    poolCount: async () => pools.length,
    poolAt: async (_factory, index) => pools[index].address,
    poolSummary: async (address) => {
      const found = pools.find(item => item.address === address)!;
      return { token0: found.token0, token1: found.token1, feeBasisPoints: found.fee, reserve0: one("100"), reserve1: one("200"), totalSupply: one("141"), factory: found.factory ?? pool(9) };
    }
  };
}

describe("walking the registry for a pair's tiers", () => {
  it("finds every tier for the pair and ignores other pairs", async () => {
    const tiers = await readPoolTiers(pool(9), A, B, reader([
      { address: pool(1), token0: A, token1: B, fee: 1 },
      { address: pool(2), token0: A, token1: C, fee: 1 },
      { address: pool(3), token0: B, token1: A, fee: 30 }
    ]));
    expect(tiers.map(item => item.feeBasisPoints)).toEqual([1, 30]);
    expect(tiers.map(item => item.pool)).toEqual([pool(1), pool(3)]);
  });

  it("keeps the registry's order rather than sorting by rate", async () => {
    const tiers = await readPoolTiers(pool(9), A, B, reader([
      { address: pool(1), token0: A, token1: B, fee: 30 },
      { address: pool(2), token0: A, token1: B, fee: 1 }
    ]));
    expect(tiers.map(item => item.feeBasisPoints)).toEqual([30, 1]);
  });

  it("returns nothing when the pair has no pool, rather than guessing", async () => {
    const tiers = await readPoolTiers(pool(9), A, B, reader([{ address: pool(1), token0: A, token1: C, fee: 1 }]));
    expect(tiers).toEqual([]);
  });

  it("stops if the registry offers two pools at one rate for one pair", async () => {
    // The factory keys pools by (token0, token1, fee), so this cannot happen unless
    // the registry and the contract disagree — which is worth failing over.
    await expect(readPoolTiers(pool(9), A, B, reader([
      { address: pool(1), token0: A, token1: B, fee: 1 },
      { address: pool(2), token0: A, token1: B, fee: 1 }
    ]))).rejects.toThrow("POOL_TIER_DUPLICATE");
  });

  it("refuses a registry too large to walk instead of truncating", async () => {
    const many: PoolTierReader = {
      poolCount: async () => 5000,
      poolAt: async () => pool(1),
      poolSummary: async () => ({ token0: A, token1: B, feeBasisPoints: 1, reserve0: 0n, reserve1: 0n, totalSupply: 0n, factory: pool(9) })
    };
    await expect(readPoolTiers(pool(9), A, B, many)).rejects.toThrow("POOL_TIER_REGISTRY_TOO_LARGE");
  });

  it("stops if a listed pool says a different factory made it", async () => {
    await expect(readPoolTiers(pool(9), A, B, reader([
      { address: pool(1), token0: A, token1: B, fee: 1, factory: pool(8) }
    ]))).rejects.toThrow("POOL_TIER_FOREIGN_POOL");
  });

  it("refuses a pair of one token", async () => {
    await expect(readPoolTiers(pool(9), A, A, reader([]))).rejects.toThrow("POOL_TIER_PAIR_INVALID");
  });
});
