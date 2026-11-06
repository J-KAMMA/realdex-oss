import { describe, expect, it } from "vitest";
import { deployerKey, loadNetworks } from "../../scripts/deployEvm.mjs";
import { EVM_NETWORKS } from "./evm-networks";

describe("scripts/deployEvm.mjs (run by the user with their own key)", () => {
  it("offers the same networks as the app and reads chain facts from the shared file", () => {
    const networks = loadNetworks();
    expect(Object.keys(networks).sort()).toEqual(Object.keys(EVM_NETWORKS).sort());
    for (const [id, info] of Object.entries(EVM_NETWORKS)) expect(networks[id].chainId).toBe(info.chainId.toString());
  });

  it("takes the key only from the user's environment and refuses to run without one", () => {
    expect(() => deployerKey({})).toThrow("DEPLOYER_KEY_MISSING");
    expect(() => deployerKey({ REALDEX_DEPLOYER_KEY_FILE: "/nonexistent/key.json" })).toThrow("DEPLOYER_KEY_MISSING");
    expect(deployerKey({ REALDEX_DEPLOYER_PRIVATE_KEY: "0xabc" })).toBe("0xabc");
  });
});