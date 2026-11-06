import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { FACTORY_ABI, POOL_ABI } from "../abi";
import type { PoolTierReading } from "./provider-tier-choice";

// Walking the registry needs its length. `allPools` is a public array, so a caller
// can index it but cannot bound the loop — which is why LocalSwapFactory gained
// `allPoolsLength()`. Without it, finding which fee tiers exist for a pair meant
// guessing a list of rates or scanning logs.
const MAX_POOLS_SCANNED = 200;

export type PoolTierReader = {
  poolCount(factory: string): Promise<number>;
  poolAt(factory: string, index: number): Promise<string>;
  poolSummary(pool: string): Promise<{ token0: string; token1: string; feeBasisPoints: number; reserve0: bigint; reserve1: bigint; totalSupply: bigint; factory: string }>;
  /** One account's LP balance in one pool. Only called when a caller asks for it. */
  lpBalanceOf?(pool: string, account: string): Promise<bigint>;
};

/**
 * Every pool on `factory` that trades `tokenA` against `tokenB`, one per fee tier,
 * in registry order. Ordering is the registry's, not a ranking: see
 * `describeProviderTiers` for why a deposit has no single right answer.
 */
export async function readPoolTiers (
  factory: string,
  tokenA: string,
  tokenB: string,
  reader: PoolTierReader,
  account?: string
): Promise<PoolTierReading[]> {
  const wanted = new Set([getAddress(tokenA).toLowerCase(), getAddress(tokenB).toLowerCase()]);
  if (wanted.size !== 2) throw new Error("POOL_TIER_PAIR_INVALID");

  const count = await reader.poolCount(factory);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("POOL_TIER_COUNT_INVALID");
  // A registry larger than this is not something a browser should walk one call at
  // a time; refusing beats quietly reporting a truncated list as the whole set.
  if (count > MAX_POOLS_SCANNED) throw new Error(`POOL_TIER_REGISTRY_TOO_LARGE: ${count}`);

  const found: PoolTierReading[] = [];
  const seenTiers = new Set<number>();
  for (let index = 0; index < count; index++) {
    const pool = getAddress(await reader.poolAt(factory, index));
    const summary = await reader.poolSummary(pool);
    // Only the factory's runtime code was checked, so a pool is trustworthy here
    // only insofar as it says that factory made it. The registry array is written
    // by createPool, so this should always hold — which is exactly why a pool that
    // fails it means something is wrong enough to stop for.
    if (getAddress(summary.factory) !== getAddress(factory)) throw new Error(`POOL_TIER_FOREIGN_POOL: ${pool}`);
    const pair = new Set([getAddress(summary.token0).toLowerCase(), getAddress(summary.token1).toLowerCase()]);
    if (pair.size !== 2 || ![...wanted].every(token => pair.has(token))) continue;
    // One pool per (pair, fee) is the factory's own rule. Two would mean the
    // registry disagrees with the contract, which is worth stopping over.
    if (seenTiers.has(summary.feeBasisPoints)) throw new Error(`POOL_TIER_DUPLICATE: ${summary.feeBasisPoints}`);
    seenTiers.add(summary.feeBasisPoints);
    found.push({ pool, feeBasisPoints: summary.feeBasisPoints, reserve0: summary.reserve0, reserve1: summary.reserve1, totalSupply: summary.totalSupply });
  }
  // Shares are pool-specific: a balance in the 30 bp pool cannot be burnt in the
  // 1 bp pool. A withdrawal screen that shows one pool's balance against all tiers
  // reads correctly and is wrong, so the balance is read per tier.
  if (account && reader.lpBalanceOf) {
    for (const tier of found) tier.lpBalance = await reader.lpBalanceOf(tier.pool, account);
  }
  return found;
}

export function createBrowserPoolTierReader (provider: JsonRpcProvider): PoolTierReader {
  return {
    poolCount: async (factory) => Number(await new Contract(factory, FACTORY_ABI, provider).allPoolsLength()),
    poolAt: async (factory, index) => new Contract(factory, FACTORY_ABI, provider).allPools(index),
    poolSummary: async (pool) => {
      const contract = new Contract(pool, POOL_ABI, provider);
      const [token0, token1, fee, reserves, totalSupply, factory] = await Promise.all([
        contract.token0(), contract.token1(), contract.feeBasisPoints(), contract.getReserves(), contract.totalSupply(), contract.factory()
      ]);
      return { token0, token1, feeBasisPoints: Number(fee), reserve0: reserves[0], reserve1: reserves[1], totalSupply, factory };
    },
    lpBalanceOf: async (pool, account) => new Contract(pool, POOL_ABI, provider).balanceOf(account)
  };
}
