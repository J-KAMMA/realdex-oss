import { describe, expect, it } from "vitest";
import { getAddress } from "ethers";
import observation from "../../artifacts-v01/pinned-address-observation.json" with { type: "json" };
import { BUILT_IN_ASSETS } from "../universe/registry";
import { ROUTE_DESCRIPTORS } from "../routing/registry";

// Base Sepolia USDC was pinned with its last character wrong for as long as this
// project existed. Nothing failed, because nothing had ever asked the chain
// whether anything was there. The observation this reads was taken on
// 2026-09-05 through the two endpoints the project itself uses, and this check
// keeps it honest: an address added or changed in the source without being
// observed makes the set disagree, and the check fails rather than the app
// quietly pointing at nothing.
//
// It reaches no network. Re-take the observation with
// scratchpad probe-pinned-addresses.mjs when an address genuinely changes.

function observedAddresses(): Set<string> {
  const found = new Set<string>();
  for (const chain of observation.chains) {
    for (const address of Object.values(chain.addresses)) found.add(getAddress(address));
  }
  return found;
}

describe("every address pinned to a public chain was observed to exist", () => {
  it("saw code at each one, through two readers that agreed", () => {
    expect(observation.chains.length).toBeGreaterThan(0);
    for (const chain of observation.chains) {
      expect(chain.readers.length, chain.name).toBe(2);
      const [first, second] = chain.readers;
      expect(first.chainIdMatches, chain.name).toBe(true);
      expect(second.chainIdMatches, chain.name).toBe(true);
      expect(first.url).not.toBe(second.url);

      for (const label of Object.keys(chain.addresses)) {
        const sizes = chain.readers.map((reader) => (reader.runtimeCodeBytes as Record<string, number>)[label]);
        // Empty is the defect. Disagreement is a different one, and just as bad.
        expect(sizes[0], `${chain.name} ${label} has no code`).toBeGreaterThan(0);
        expect(sizes[1], `${chain.name} ${label} readers disagree`).toBe(sizes[0]);
      }
    }
  });

  it("covers every EVM address the application itself pins", () => {
    const observed = observedAddresses();

    const assetAddresses = BUILT_IN_ASSETS
      .filter((asset) => asset.assetType.includes("/erc20:"))
      .map((asset) => asset.assetType.slice(asset.assetType.indexOf("/erc20:") + 7))
      .filter((address) => /^0x[0-9a-fA-F]{40}$/.test(address));
    expect(assetAddresses.length).toBeGreaterThan(0);

    const executionTargets = ROUTE_DESCRIPTORS
      .filter((route) => route.sourceAsset.startsWith("eip155:"))
      .map((route) => route.sourceExecutionTarget)
      .filter((target) => /^0x[0-9a-fA-F]{40}$/.test(target));
    expect(executionTargets.length).toBeGreaterThan(0);

    for (const address of [...assetAddresses, ...executionTargets]) {
      expect(observed.has(getAddress(address)), `${address} is pinned but was never observed`).toBe(true);
    }
  });
});
