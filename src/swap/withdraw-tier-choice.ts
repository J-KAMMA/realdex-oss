import { formatUnits } from "ethers";
import { formatFeeTier } from "./evm-venue-discovery";
import type { PoolTierReading } from "./provider-tier-choice";

export type WithdrawTierRow = {
  pool: string;
  label: string;
  lpBalance: bigint;
  lpLabel: string;
  /** What burning the whole balance would return at the current reserves. */
  whole0: bigint;
  whole1: bigint;
  wholeLabel: string;
  selected: boolean;
  /** Nothing to withdraw here. */
  empty: boolean;
};

/**
 * Which pools this account can withdraw from, one row per fee tier.
 *
 * Shares are pool-specific: an LP balance in the 30 bp pool cannot be burnt in the
 * 1 bp pool, and the two pools do not even agree on what a share is worth. Once a
 * provider can choose where to deposit, the withdrawal side has to name the pool
 * too — showing one pool's balance while burning against another is the shape of
 * defect that reads correctly and is wrong.
 *
 * Unlike the deposit list this one is not a choice between comparable options: a
 * row with no balance is not an alternative, it is a pool this account never used.
 */
export function describeWithdrawTiers (
  tiers: readonly PoolTierReading[],
  selectedPool: string,
  decimals0: number,
  decimals1: number
): WithdrawTierRow[] {
  return tiers.map((tier) => {
    const lpBalance = tier.lpBalance ?? 0n;
    const [whole0, whole1] = withdrawalAmounts(lpBalance, tier);
    return {
      pool: tier.pool,
      label: formatFeeTier(tier.feeBasisPoints),
      lpBalance,
      lpLabel: formatUnits(lpBalance, 18),
      whole0,
      whole1,
      wholeLabel: `${formatUnits(whole0, decimals0)} / ${formatUnits(whole1, decimals1)}`,
      selected: tier.pool.toLowerCase() === selectedPool.toLowerCase(),
      empty: lpBalance === 0n
    };
  });
}

/**
 * What burning `shares` returns, using the pool's own formula so the figure on
 * screen is the one the contract will compute rather than a second implementation
 * of the same rule that drifts away from it.
 */
export function withdrawalAmounts (
  shares: bigint,
  tier: Pick<PoolTierReading, "reserve0" | "reserve1" | "totalSupply">
): readonly [bigint, bigint] {
  if (shares <= 0n || tier.totalSupply === 0n) return [0n, 0n] as const;
  return [(shares * tier.reserve0) / tier.totalSupply, (shares * tier.reserve1) / tier.totalSupply] as const;
}

/** The tier a withdrawal should default to: the only one holding shares, if there is exactly one. */
export function defaultWithdrawPool (tiers: readonly PoolTierReading[], fallback: string): string {
  const held = tiers.filter(tier => (tier.lpBalance ?? 0n) > 0n);
  return held.length === 1 ? held[0].pool : fallback;
}
