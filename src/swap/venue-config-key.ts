/**
 * The identity of a discovery configuration.
 *
 * Discovery is asynchronous, so the screen keeps this string alongside the result
 * and refuses to quote from a result whose key is not the current one. That only
 * works if every input that changes what discovery would find is part of the
 * string — and if the string is recomputed whenever one of them changes.
 *
 * It was an inline memo, and its dependency list had drifted from what it read:
 * the fee tiers were in the string but not in the list, so changing the tiers
 * produced the same key for a different configuration. Nothing observable broke,
 * because the discovery effect names the tiers in its own dependencies and re-ran
 * anyway — but the guard was not guarding what it claims to. As a function it can
 * be tested, which is the point of moving it out.
 */
export function venueConfigKey (config: {
  chainId: bigint;
  factoryAddress: string;
  additionalFactories: string;
  feeTiers: string;
  routerAddress: string;
  intermediateTokens: string;
  tokenIn: string;
  tokenOut: string;
}): string {
  return [
    config.chainId,
    config.factoryAddress.trim().toLowerCase(),
    config.additionalFactories.trim().toLowerCase(),
    config.feeTiers.trim(),
    config.routerAddress.trim().toLowerCase(),
    config.intermediateTokens.trim().toLowerCase(),
    config.tokenIn.toLowerCase(),
    config.tokenOut.toLowerCase()
  ].join("|");
}
