import { formatUnits } from "ethers";
import type { RouteQuote } from "../routing/types";
import { formatFeeTier } from "./evm-venue-discovery";

export type FeeTierComparisonRow = {
  routeId: string;
  /** The tier, or "multi-hop" for a path that is not a single tiered pool. */
  label: string;
  minimumOut: string;
  selected: boolean;
  /** How far behind the winner, in basis points of the winner's own output. */
  behindBasisPoints: number;
};

/**
 * Turns the engine's ranked quotes into the rows a participant reads.
 *
 * The point of the row is that a cheaper tier is not automatically a better
 * price: a thin 1 bp pool loses to a deep 30 bp one, and the only way to know
 * which wins is to quote both against this amount. Showing the tier alone would
 * invite exactly the wrong conclusion, so the tier is always shown next to what
 * it would actually pay.
 *
 * `quotes` must arrive in the engine's order (most received first); this does not
 * re-rank them, because the ranking that gets executed is the engine's.
 */
export function compareFeeTiers(
  quotes: readonly RouteQuote[],
  feeBasisPointsByRouteId: ReadonlyMap<string, number>,
  outputDecimals: number
): FeeTierComparisonRow[] {
  if (!quotes.length) return [];
  const best = quotes[0].minimumOutBaseUnits;
  return quotes.map((quote) => ({
    routeId: quote.routeId,
    label: feeBasisPointsByRouteId.has(quote.routeId) ? formatFeeTier(feeBasisPointsByRouteId.get(quote.routeId)!) : "multi-hop",
    minimumOut: formatUnits(quote.minimumOutBaseUnits, outputDecimals),
    selected: quote.routeId === quotes[0].routeId,
    // Integer basis points of the winner. Two tiers separated by less than one
    // basis point read as 0, which is the honest answer: the choice did not matter.
    behindBasisPoints: best <= 0n ? 0 : Number(((best - quote.minimumOutBaseUnits) * 10_000n) / best)
  }));
}
