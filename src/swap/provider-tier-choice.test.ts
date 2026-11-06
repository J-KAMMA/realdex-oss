import { describe, expect, it } from "vitest";
import { PROVIDER_TIER_DISCLAIMER, describeProviderTiers, type PoolTierReading } from "./provider-tier-choice";

const one = (value: string) => BigInt(value) * 10n ** 18n;

const thin: PoolTierReading = {
  pool: "0x1111111111111111111111111111111111111111",
  feeBasisPoints: 1,
  reserve0: one("10000"),
  reserve1: one("20000"),
  totalSupply: one("14142")
};

const deep: PoolTierReading = {
  pool: "0x2222222222222222222222222222222222222222",
  feeBasisPoints: 30,
  reserve0: one("200000"),
  reserve1: one("400000"),
  totalSupply: one("282842")
};

describe("what a provider can be told about the tiers", () => {
  it("says how deep each tier is and how much of it the deposit buys", () => {
    const rows = describeProviderTiers([thin, deep], one("100"), one("500"), thin.pool, 18, 18);
    expect(rows[0]).toMatchObject({ label: "1 bp (0.01%)", depth: "10000.0 / 20000.0", selected: true });
    expect(rows[1]).toMatchObject({ label: "30 bp (0.30%)", depth: "200000.0 / 400000.0", selected: false });

    // The same deposit buys a bigger slice of the thin pool than of the deep one.
    expect(rows[0].shareBasisPoints).toBeGreaterThan(rows[1].shareBasisPoints);
  });

  it("settles each tier against its own ratio, not a shared one", () => {
    // Both pools are 1 : 2 here, so 100 / 500 is taken as 100 / 200 in both.
    const rows = describeProviderTiers([thin, deep], one("100"), one("500"), thin.pool, 18, 18);
    for (const row of rows) {
      expect(row.taken0).toBe(one("100"));
      expect(row.taken1).toBe(one("200"));
    }
  });

  it("does not rank the tiers", () => {
    const rows = describeProviderTiers([deep, thin], one("100"), one("200"), thin.pool, 18, 18);
    // The order given is the order returned; nothing is sorted or marked "best".
    expect(rows.map((row) => row.label)).toEqual(["30 bp (0.30%)", "1 bp (0.01%)"]);
    expect(Object.keys(rows[0])).not.toContain("best");
  });

  it("marks an empty pool instead of pretending it can price a deposit", () => {
    const fresh: PoolTierReading = { pool: "0x3333333333333333333333333333333333333333", feeBasisPoints: 5, reserve0: 0n, reserve1: 0n, totalSupply: 0n };
    const [row] = describeProviderTiers([fresh], one("100"), one("200"), fresh.pool, 18, 18);
    expect(row.empty).toBe(true);
    expect(row.shareLabel).toBe("—");
  });

  it("says less than a basis point rather than rounding it to nothing", () => {
    const huge: PoolTierReading = { pool: "0x4444444444444444444444444444444444444444", feeBasisPoints: 1, reserve0: one("100000000"), reserve1: one("200000000"), totalSupply: one("141421356") };
    const [row] = describeProviderTiers([huge], one("1"), one("2"), huge.pool, 18, 18);
    expect(row.shareLabel).toBe("<0.01%");
  });

  it("reports nothing taken when no amount was entered", () => {
    const [row] = describeProviderTiers([thin], 0n, 0n, thin.pool, 18, 18);
    expect(row.taken0).toBe(0n);
    expect(row.taken1).toBe(0n);
    expect(row.shareLabel).toBe("—");
  });

  it("carries a disclaimer that names what the screen cannot know", () => {
    expect(PROVIDER_TIER_DISCLAIMER).toContain("将来の取引量");
    expect(PROVIDER_TIER_DISCLAIMER).toContain("予測ではありません");
  });
});
