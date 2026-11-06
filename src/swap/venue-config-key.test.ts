import { describe, expect, it } from "vitest";
import { venueConfigKey } from "./venue-config-key";

const base = {
  chainId: 31337n,
  factoryAddress: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
  additionalFactories: "0x0B306BF915C4d645ff596e518fAf3F9669b97016",
  feeTiers: "1, 30",
  routerAddress: "0x67d269191c92Caf3cD7723F116c85e6E9bf55933",
  intermediateTokens: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  tokenIn: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  tokenOut: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
};

describe("the identity of a discovery configuration", () => {
  it("changes when any input that changes what discovery finds changes", () => {
    const keys = new Map<string, string>();
    for (const [field, value] of [
      ["chainId", 8453n],
      ["factoryAddress", "0x1b2B307F1AaE38f029290eD5AD7CC459069851B2"],
      ["additionalFactories", ""],
      // The one that had drifted: the tiers were in the string, absent from the
      // memo's dependency list, so this key stayed the same for a changed config.
      ["feeTiers", "1"],
      ["routerAddress", ""],
      ["intermediateTokens", ""],
      ["tokenIn", "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"],
      ["tokenOut", "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"]
    ] as Array<[keyof typeof base, never]>) {
      keys.set(field, venueConfigKey({ ...base, [field]: value }));
    }
    const original = venueConfigKey(base);
    for (const [field, key] of keys) expect(key, `${field} did not change the key`).not.toBe(original);
    // And each change produces a distinct key, not merely a different one.
    expect(new Set([...keys.values(), original]).size).toBe(keys.size + 1);
  });

  it("ignores surrounding whitespace and address case, which do not change the search", () => {
    expect(venueConfigKey({ ...base, factoryAddress: `  ${base.factoryAddress.toLowerCase()}  ` })).toBe(venueConfigKey(base));
    expect(venueConfigKey({ ...base, feeTiers: "  1, 30  " })).toBe(venueConfigKey(base));
    expect(venueConfigKey({ ...base, tokenIn: base.tokenIn.toUpperCase().replace("0X", "0x") })).toBe(venueConfigKey(base));
  });

  it("keeps the tiers case-sensitive to their spacing inside the list, because the parser is", () => {
    // "1,30" and "1, 30" parse to the same tiers, so they may share a key; what
    // must not happen is two different tier sets sharing one.
    expect(venueConfigKey({ ...base, feeTiers: "30, 1" })).not.toBe(venueConfigKey(base));
  });
});
