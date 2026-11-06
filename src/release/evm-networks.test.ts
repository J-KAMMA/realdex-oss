import { describe, expect, it } from "vitest";
import { EVM_NETWORKS, assertContractsConfigured, evmNetworkByChainId, isMainnetChainId, networkContractsMessage, resolveEvmNetwork } from "./evm-networks";

const FACTORY = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";

describe("selectable EVM networks", () => {
  it("lists Base and Arbitrum One next to their testnet counterparts", () => {
    expect(Object.keys(EVM_NETWORKS).sort()).toEqual(["eip155:42161", "eip155:421614", "eip155:8453", "eip155:84532"]);
    for (const network of Object.values(EVM_NETWORKS)) {
      expect(EVM_NETWORKS[network.counterpart].counterpart).toBe(network.id);
      expect(EVM_NETWORKS[network.counterpart].environment).not.toBe(network.environment);
      expect(network.id).toBe(`eip155:${network.chainId}`);
      expect(network.rpcUrls.length).toBeGreaterThanOrEqual(2);
      for (const url of network.rpcUrls) expect(new URL(url).protocol).toBe("https:");
    }
    expect(EVM_NETWORKS["eip155:8453"].environment).toBe("mainnet");
    expect(EVM_NETWORKS["eip155:42161"].environment).toBe("mainnet");
    expect(isMainnetChainId("8453")).toBe(true);
    expect(isMainnetChainId(84532)).toBe(false);
    expect(isMainnetChainId("31337")).toBe(false);
    expect(evmNetworkByChainId("42161")?.name).toBe("Arbitrum One");
  });

  it("ships no contract address or operator endpoint", () => {
    expect(JSON.stringify(EVM_NETWORKS, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it("uses user-supplied RPCs and contracts, with the environment before the defaults", () => {
    const own = ["https://rpc.user-a.example", "https://rpc.user-b.example"];
    expect(resolveEvmNetwork("eip155:8453", {}, {}).rpcUrls).toEqual([...EVM_NETWORKS["eip155:8453"].rpcUrls]);
    expect(resolveEvmNetwork("eip155:8453", {}, { VITE_REALDEX_RPC_8453: "https://env-a.example, https://env-b.example" }).rpcUrls).toEqual(["https://env-a.example", "https://env-b.example"]);
    const resolved = resolveEvmNetwork("eip155:8453", { rpcUrls: own, factory: FACTORY, router: ROUTER }, { VITE_REALDEX_RPC_8453: "https://env.example" });
    expect(resolved.rpcUrls).toEqual(own);
    expect(resolved.network.environment).toBe("mainnet");
    expect(resolved.contracts).toEqual({ factory: FACTORY, router: ROUTER });
    expect(() => resolveEvmNetwork("eip155:8453", { factory: FACTORY, router: FACTORY }, {})).toThrow("NETWORK_CONTRACTS_NOT_DISTINCT");
    expect(() => resolveEvmNetwork("eip155:8453", { factory: "nope", router: ROUTER }, {})).toThrow("NETWORK_CONTRACT_ADDRESS_INVALID");
  });

  it("refuses a mainnet that has no user-configured contracts", () => {
    expect(resolveEvmNetwork("eip155:42161", {}, {}).contracts).toBeNull();
    expect(resolveEvmNetwork("eip155:42161", { factory: FACTORY }, {}).contracts).toBeNull();
    expect(() => assertContractsConfigured("8453", "")).toThrow("NETWORK_CONTRACTS_NOT_CONFIGURED");
    expect(() => assertContractsConfigured(42161n, undefined)).toThrow("NETWORK_CONTRACTS_NOT_CONFIGURED");
    expect(() => assertContractsConfigured("8453", FACTORY)).not.toThrow();
    expect(() => assertContractsConfigured("31337", "")).not.toThrow();
    expect(networkContractsMessage(EVM_NETWORKS["eip155:8453"])).toContain("Base");
  });
});