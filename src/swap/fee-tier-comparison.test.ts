import { describe, expect, it } from "vitest";
import type { RouteQuote } from "../routing/types";
import { compareFeeTiers } from "./fee-tier-comparison";

const quote = (routeId: string, minimumOut: bigint) => ({ routeId, minimumOutBaseUnits: minimumOut }) as unknown as RouteQuote;

describe("fee tier comparison", () => {
  it("shows what each tier would actually pay, not just the tier", () => {
    // The deep 30 bp pool wins. Presenting tiers without their output would make
    // this look like the wrong choice, which is the reason the row exists.
    const quotes = [quote("route:30", 1_000_000n), quote("route:1", 900_000n)];
    const fees = new Map([["route:30", 30], ["route:1", 1]]);
    const rows = compareFeeTiers(quotes, fees, 6);
    expect(rows[0]).toMatchObject({ label: "30 bp (0.30%)", minimumOut: "1.0", selected: true, behindBasisPoints: 0 });
    expect(rows[1]).toMatchObject({ label: "1 bp (0.01%)", minimumOut: "0.9", selected: false, behindBasisPoints: 1000 });
  });

  it("keeps the engine's order rather than re-ranking", () => {
    const quotes = [quote("a", 10n), quote("b", 9n), quote("c", 8n)];
    const rows = compareFeeTiers(quotes, new Map(), 0);
    expect(rows.map((row) => row.routeId)).toEqual(["a", "b", "c"]);
    expect(rows.filter((row) => row.selected)).toHaveLength(1);
  });

  it("calls a route with no tier a multi-hop, instead of inventing one", () => {
    const rows = compareFeeTiers([quote("hop", 5n)], new Map(), 0);
    expect(rows[0].label).toBe("multi-hop");
  });

  it("reads a difference under one basis point as no difference", () => {
    const quotes = [quote("a", 10_000_000n), quote("b", 9_999_999n)];
    const rows = compareFeeTiers(quotes, new Map(), 0);
    expect(rows[1].behindBasisPoints).toBe(0);
  });

  it("has nothing to compare when nothing was quoted", () => {
    expect(compareFeeTiers([], new Map(), 18)).toEqual([]);
  });

  it("does not divide by a winner of zero", () => {
    const rows = compareFeeTiers([quote("a", 0n), quote("b", 0n)], new Map(), 18);
    expect(rows.every((row) => row.behindBasisPoints === 0)).toBe(true);
  });
});
