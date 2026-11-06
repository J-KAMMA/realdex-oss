import { describe, expect, it } from "vitest";
import { depositResidue } from "./deposit-residue";

// The numbers here are the ones measured on a local chain, through the screen:
// a 100 / 500 deposit into a 1 : 2 pool is taken as 100 / 200 and leaves 300
// approved. If this function stops agreeing with LocalSwapPool.addLiquidity, the
// screen starts lying about the approval again.
const one = (value: string) => BigInt(value) * 10n ** 18n;

describe("what the pool will take, and what stays approved", () => {
  it("matches the measured off-ratio deposit", () => {
    const residue = depositResidue(one("100"), one("500"), one("10000"), one("20000"));
    expect(residue).toEqual({ taken0: one("100"), taken1: one("200"), left0: 0n, left1: one("300") });
  });

  it("leaves nothing when the deposit is on ratio", () => {
    const residue = depositResidue(one("100"), one("200"), one("10000"), one("20000"));
    expect(residue).toEqual({ taken0: one("100"), taken1: one("200"), left0: 0n, left1: 0n });
  });

  it("rounds the other side when token 0 is the surplus", () => {
    const residue = depositResidue(one("400"), one("200"), one("10000"), one("20000"));
    expect(residue).toEqual({ taken0: one("100"), taken1: one("200"), left0: one("300"), left1: 0n });
  });

  it("takes both sides whole into an empty pool", () => {
    const residue = depositResidue(one("5"), one("7"), 0n, 0n);
    expect(residue).toEqual({ taken0: one("5"), taken1: one("7"), left0: 0n, left1: 0n });
  });

  it("has nothing to say until both amounts are entered", () => {
    expect(depositResidue(0n, one("5"), one("10"), one("20"))).toBeNull();
    expect(depositResidue(one("5"), 0n, one("10"), one("20"))).toBeNull();
  });

  it("rounds down, so it never promises more than the pool takes", () => {
    // 3 into a 10 : 7 pool credits 2.1, which truncates to 2.
    const residue = depositResidue(3n, 100n, 10n, 7n);
    expect(residue).toEqual({ taken0: 3n, taken1: 2n, left0: 0n, left1: 98n });
  });
});
