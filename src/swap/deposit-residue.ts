export type DepositResidue = {
  /** What the pool credits at the current ratio. */
  taken0: bigint;
  taken1: bigint;
  /** What stays approved on the pool because it was not taken. */
  left0: bigint;
  left1: bigint;
};

/**
 * Mirrors `LocalSwapPool.addLiquidity`'s ratio rounding so a screen can say what
 * the pool will actually take before the deposit is sent.
 *
 * It matters because the two numbers differ. The pool takes only what the current
 * ratio credits; the screen approves what was typed. Off ratio, the difference is
 * left approved on the pool afterwards — 300 JADE for a 100 / 500 deposit into a
 * 1 : 2 pool, measured on a local chain through the screen itself — while the
 * panel claimed the approval scope was exact.
 *
 * This is a display, not a fix. Reserves move between reading them and the
 * transaction being mined, so the real residue can differ from this one. Settling
 * the ratio at execution time needs a router-side addLiquidity; see
 * the internal design notes (not published).
 */
export function depositResidue(amount0: bigint, amount1: bigint, reserve0: bigint, reserve1: bigint): DepositResidue | null {
  if (amount0 <= 0n || amount1 <= 0n) return null;
  // An empty pool takes both sides whole: there is no ratio to round to yet.
  if (reserve0 <= 0n || reserve1 <= 0n) return { taken0: amount0, taken1: amount1, left0: 0n, left1: 0n };
  const optimal1 = (amount0 * reserve1) / reserve0;
  const taken0 = optimal1 <= amount1 ? amount0 : (amount1 * reserve0) / reserve1;
  const taken1 = optimal1 <= amount1 ? optimal1 : amount1;
  return { taken0, taken1, left0: amount0 - taken0, left1: amount1 - taken1 };
}
