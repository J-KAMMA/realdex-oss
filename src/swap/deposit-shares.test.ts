import { describe, expect, it } from "vitest";
import { MINIMUM_LIQUIDITY, estimateLiquidityShares, sqrtBigInt } from "./deposit-shares";

const one = (value: string) => BigInt(value) * 10n ** 18n;

// Two pools for one pair, at two fee tiers. They hold different books: the thin
// one was seeded at the geometric mean, the deep one has since traded, so its
// shares are worth more reserve than the thin one's. This is the ordinary state
// of two tiers after any trading at all.
const thin = { reserve0: one("10000"), reserve1: one("20000"), totalSupply: one("14142") };
const deep = { reserve0: one("199292"), reserve1: one("398585"), totalSupply: one("281842") };

describe("shares a deposit mints", () => {
  it("differs between two tiers of the same pair, so the pool has to be named", () => {
    const inThin = estimateLiquidityShares(one("100"), one("200"), thin.reserve0, thin.reserve1, thin.totalSupply);
    const inDeep = estimateLiquidityShares(one("100"), one("200"), deep.reserve0, deep.reserve1, deep.totalSupply);
    expect(inThin).not.toBe(inDeep);
    // Reading the verified pool's book while depositing into the other tier is
    // the defect this module exists to make visible. With these two books the
    // thin pool's answer is short by this much, and the minimum-shares floor sent
    // with the transaction inherits the error either way.
    expect(inDeep - inThin).toBe(1277770111770387n);
  });

  it("uses the pool's own integer formula, rounding down as the contract does", () => {
    // shares = min(amount0 * supply / reserve0, amount1 * supply / reserve1)
    expect(estimateLiquidityShares(3n, 3n, 100n, 201n, 7n)).toBe(0n);
    expect(estimateLiquidityShares(50n, 50n, 100n, 201n, 7n)).toBe(1n);
  });

  it("takes the smaller of the two sides, which is what an off-ratio deposit credits", () => {
    const balanced = estimateLiquidityShares(one("100"), one("200"), thin.reserve0, thin.reserve1, thin.totalSupply);
    const generousOnOneSide = estimateLiquidityShares(one("100"), one("5000"), thin.reserve0, thin.reserve1, thin.totalSupply);
    expect(generousOnOneSide).toBe(balanced);
  });

  it("burns the fixed minimum on the first deposit rather than crediting it", () => {
    const root = sqrtBigInt(one("100") * one("400"));
    expect(estimateLiquidityShares(one("100"), one("400"), 0n, 0n, 0n)).toBe(root - MINIMUM_LIQUIDITY);
  });

  it("refuses a first deposit too small to survive the burn, instead of returning a negative", () => {
    expect(() => estimateLiquidityShares(10n, 10n, 0n, 0n, 0n)).toThrow("初期流動性");
    expect(() => estimateLiquidityShares(1_000_000n, 1_000n, 0n, 0n, 0n)).not.toThrow();
  });

  it("refuses an existing pool whose reserves could not be read, instead of dividing by zero", () => {
    expect(() => estimateLiquidityShares(one("1"), one("1"), 0n, one("1"), one("1"))).toThrow("reserves");
    expect(() => estimateLiquidityShares(one("1"), one("1"), one("1"), 0n, one("1"))).toThrow("reserves");
  });
});

describe("integer square root", () => {
  it("floors, and is exact on perfect squares", () => {
    expect(sqrtBigInt(0n)).toBe(0n);
    expect(sqrtBigInt(1n)).toBe(1n);
    expect(sqrtBigInt(8n)).toBe(2n);
    expect(sqrtBigInt(9n)).toBe(3n);
    expect(sqrtBigInt(one("100") * one("100"))).toBe(one("100"));
  });

  it("refuses a negative value rather than looping", () => {
    expect(() => sqrtBigInt(-1n)).toThrow("positive");
  });
});
