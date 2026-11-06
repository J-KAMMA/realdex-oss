import { describe, expect, it } from "vitest";
import { getAddress } from "ethers";
import type { PoolTierReading } from "./provider-tier-choice";
import { defaultWithdrawPool, describeWithdrawTiers, withdrawalAmounts } from "./withdraw-tier-choice";

const pool = (n: number) => getAddress(`0x${String(n).padStart(40, "0")}`);
const one = (value: string) => BigInt(value) * 10n ** 18n;

const thin: PoolTierReading = { pool: pool(1), feeBasisPoints: 1, reserve0: one("100"), reserve1: one("200"), totalSupply: one("141"), lpBalance: one("14") };
const deep: PoolTierReading = { pool: pool(2), feeBasisPoints: 30, reserve0: one("2000"), reserve1: one("4000"), totalSupply: one("2828"), lpBalance: 0n };

describe("choosing which pool to withdraw from", () => {
  it("reports the balance and the whole-balance value for each tier separately", () => {
    const rows = describeWithdrawTiers([thin, deep], thin.pool, 18, 18);
    expect(rows.map(row => row.lpBalance)).toEqual([one("14"), 0n]);
    // 14/141 of 100 and of 200.
    expect(rows[0].whole0).toBe((one("14") * one("100")) / one("141"));
    expect(rows[0].whole1).toBe((one("14") * one("200")) / one("141"));
    expect(rows[1].whole0).toBe(0n);
    expect(rows[0].empty).toBe(false);
    expect(rows[1].empty).toBe(true);
  });

  it("marks the selected pool and nothing else", () => {
    const rows = describeWithdrawTiers([thin, deep], deep.pool, 18, 18);
    expect(rows.map(row => row.selected)).toEqual([false, true]);
  });

  it("matches by address regardless of case, so a lowercase selection still marks its row", () => {
    const rows = describeWithdrawTiers([thin, deep], thin.pool.toLowerCase(), 18, 18);
    expect(rows[0].selected).toBe(true);
  });

  it("treats a reading with no balance field as no balance rather than throwing", () => {
    const { lpBalance: _dropped, ...withoutBalance } = thin;
    const rows = describeWithdrawTiers([withoutBalance], thin.pool, 18, 18);
    expect(rows[0].lpBalance).toBe(0n);
    expect(rows[0].empty).toBe(true);
  });
});

describe("what burning shares returns", () => {
  it("uses the pool's own formula, rounding down as the contract does", () => {
    // The contract computes (shares * reserve) / totalSupply in integer maths.
    const tier = { reserve0: 100n, reserve1: 201n, totalSupply: 7n };
    expect(withdrawalAmounts(3n, tier)).toEqual([42n, 86n]);
  });

  it("returns nothing for an empty pool instead of dividing by zero", () => {
    expect(withdrawalAmounts(one("1"), { reserve0: 0n, reserve1: 0n, totalSupply: 0n })).toEqual([0n, 0n]);
  });

  it("returns nothing for zero or negative shares", () => {
    expect(withdrawalAmounts(0n, thin)).toEqual([0n, 0n]);
    expect(withdrawalAmounts(-1n, thin)).toEqual([0n, 0n]);
  });
});

describe("which pool a withdrawal should default to", () => {
  it("picks the only tier holding shares", () => {
    expect(defaultWithdrawPool([thin, deep], pool(9))).toBe(thin.pool);
  });

  it("falls back to the verified pool when shares are held in more than one", () => {
    expect(defaultWithdrawPool([thin, { ...deep, lpBalance: one("1") }], pool(9))).toBe(pool(9));
  });

  it("falls back to the verified pool when nothing is held anywhere", () => {
    expect(defaultWithdrawPool([{ ...thin, lpBalance: 0n }, deep], pool(9))).toBe(pool(9));
  });
});
