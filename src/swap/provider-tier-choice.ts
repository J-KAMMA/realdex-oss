import { formatUnits } from "ethers";
import { depositResidue } from "./deposit-residue";
import { formatFeeTier } from "./evm-venue-discovery";

export type PoolTierReading = {
  pool: string;
  feeBasisPoints: number;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  /** This account's LP balance in this pool, when a caller asked for it. */
  lpBalance?: bigint;
};

export type ProviderTierRow = {
  pool: string;
  label: string;
  /** What this tier's pool would actually take at its own ratio. */
  taken0: bigint;
  taken1: bigint;
  depth: string;
  /** Share of the pool the deposit would buy, in basis points. */
  shareBasisPoints: number;
  shareLabel: string;
  selected: boolean;
  /** No pool yet, or none that can price a deposit. */
  empty: boolean;
};

/**
 * Describes each fee tier a provider could deposit into.
 *
 * Deliberately does **not** rank them. A swap has one right answer — the route
 * that pays most for this amount, decided now — and `compareFeeTiers` ranks those.
 * A deposit does not: the fee income depends on future trading volume and the loss
 * depends on future price movement, and neither is on screen or knowable from it.
 * What can be shown is how deep each pool is and how much of it the deposit buys.
 *
 * Presenting these next to each other without saying that invites the reader to
 * treat the list as a recommendation, which is why the caller must show
 * `PROVIDER_TIER_DISCLAIMER` alongside it.
 */
export function describeProviderTiers(
  tiers: readonly PoolTierReading[],
  amount0: bigint,
  amount1: bigint,
  selectedPool: string,
  decimals0: number,
  decimals1: number
): ProviderTierRow[] {
  return tiers.map((tier) => {
    const settled = depositResidue(amount0, amount1, tier.reserve0, tier.reserve1);
    const taken0 = settled?.taken0 ?? 0n;
    const taken1 = settled?.taken1 ?? 0n;
    // The pool's own share formula, so the number matches what minting would give.
    const shares = tier.totalSupply === 0n || tier.reserve0 === 0n || tier.reserve1 === 0n
      ? 0n
      : min((taken0 * tier.totalSupply) / tier.reserve0, (taken1 * tier.totalSupply) / tier.reserve1);
    const after = tier.totalSupply + shares;
    const shareBasisPoints = after === 0n ? 0 : Number((shares * 10_000n) / after);
    return {
      pool: tier.pool,
      label: formatFeeTier(tier.feeBasisPoints),
      taken0,
      taken1,
      depth: `${formatUnits(tier.reserve0, decimals0)} / ${formatUnits(tier.reserve1, decimals1)}`,
      shareBasisPoints,
      // Below a basis point, printing "0.00%" is more honest than a rounded figure.
      shareLabel: shares === 0n ? "—" : shareBasisPoints === 0 ? "<0.01%" : `${(shareBasisPoints / 100).toFixed(2)}%`,
      selected: tier.pool.toLowerCase() === selectedPool.toLowerCase(),
      empty: tier.reserve0 === 0n || tier.reserve1 === 0n
    };
  });
}

export const PROVIDER_TIER_DISCLAIMER =
  "手数料収入は将来の取引量に、損失は将来の価格変動によります。どちらもこの画面にはありません。ここに出ているのは現在の深さと、預けた場合の持分比率だけで、どの料率が得かの予測ではありません。";

function min (left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
