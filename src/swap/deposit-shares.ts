/**
 * How many LP shares a deposit mints, using the pool's own formula.
 *
 * The figure matters twice: it is what the review panel shows, and it is what the
 * minimum-shares floor sent with the transaction is derived from. That floor is
 * the only protection a depositor has if the pool's ratio moves between the quote
 * and the mined transaction — so it has to be computed against **the pool being
 * deposited into**. Once a screen offers several fee tiers for one pair, reading
 * the verified pool's reserves and supply while depositing into another tier
 * produces a floor that is about a different book. It looks right and is not.
 *
 * Kept as its own module rather than a helper inside the screen so that the
 * dependence on the target pool can be stated in tests.
 */
export function estimateLiquidityShares (
  amount0: bigint,
  amount1: bigint,
  reserve0: bigint,
  reserve1: bigint,
  totalSupply: bigint
): bigint {
  if (!totalSupply) {
    // First deposit: the pool mints sqrt(amount0 * amount1) and burns a fixed
    // minimum to address(1), so the depositor never receives that part.
    const root = sqrtBigInt(amount0 * amount1);
    if (root <= MINIMUM_LIQUIDITY) throw new Error("初期流動性が少なすぎます。");
    return root - MINIMUM_LIQUIDITY;
  }
  if (!reserve0 || !reserve1) throw new Error("Pool reserves are unavailable.");
  const shares0 = (amount0 * totalSupply) / reserve0;
  const shares1 = (amount1 * totalSupply) / reserve1;
  return shares0 < shares1 ? shares0 : shares1;
}

/** The pool burns this much of the first deposit's shares, permanently. */
export const MINIMUM_LIQUIDITY = 1_000n;

export function sqrtBigInt (value: bigint): bigint {
  if (value < 0n) throw new Error("Square root only supports positive values.");
  if (value < 2n) return value;
  let previous = value / 2n;
  let next = (previous + value / previous) / 2n;
  while (next < previous) { previous = next; next = (previous + value / previous) / 2n; }
  return previous;
}
