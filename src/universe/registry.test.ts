import { getAddress } from "ethers";
import { describe, expect, it } from "vitest";
import { BUILT_IN_ASSETS, CHAIN_NAMESPACES, WALLET_CAPABILITIES, capabilitySummary, isCaip2, isCaip19, validateAssetManifest } from "./registry";

describe("universal capability registry", () => {
  it("keeps Base Sepolia USDC behind the closed CCTP release gate", () => {
    expect(BUILT_IN_ASSETS.find((asset) => asset.assetType.startsWith("eip155:84532/erc20:"))?.execution).toBe("design-gate");
  });

  it("uses unique CAIP namespaces and keeps swap, bridge, and finality adapters operation-specific", () => {
    expect(new Set(CHAIN_NAMESPACES.map((chain) => chain.namespace)).size).toBe(CHAIN_NAMESPACES.length);
    for (const chain of CHAIN_NAMESPACES) {
      for (const operation of ["quote-swap", "execute-swap", "bridge", "track-finality"] as const) {
        if (chain.operations[operation] !== "design-gate") expect(chain.adapterIds?.[operation]).toBeTruthy();
      }
    }
    const solana = CHAIN_NAMESPACES.find((chain) => chain.namespace === "solana")!;
    expect(solana.operations["quote-swap"]).toBe("partial");
    expect(solana.operations["execute-swap"]).toBe("design-gate");
    expect(solana.adapterIds).toMatchObject({ "quote-swap": "solana-swap-boundary", bridge: "cctp-v2" });
    const cosmos = CHAIN_NAMESPACES.find((chain) => chain.namespace === "cosmos")!;
    expect(cosmos.operations["connect-wallet"]).toBe("partial");
    expect(cosmos.operations["quote-swap"]).toBe("partial");
    expect(cosmos.operations["execute-swap"]).toBe("design-gate");
    expect(cosmos.adapterIds).toMatchObject({ "quote-swap": "cosmos-swap-boundary", bridge: "ibc-ics20", "track-finality": "ibc-ics20" });
  });

  it("validates CAIP-2 and CAIP-19 identities without trusting symbols", () => {
    expect(isCaip2("eip155:1")).toBe(true);
    expect(isCaip2("cosmos:osmosis-1")).toBe(true);
    expect(isCaip19("eip155:1/erc20:0x6b175474e89094c44da98b954eedeac495271d0f")).toBe(true);
    expect(isCaip19("USDC")).toBe(false);
    expect(BUILT_IN_ASSETS.every((asset) => isCaip19(asset.assetType))).toBe(true);
  });

  it("keeps imported token manifests inspection-only", () => {
    const manifest = {
      schema: "localswap.asset-manifest.v1", name: "Example", revision: 1,
      evidenceUrls: ["https://example.invalid/list"],
      assets: [{ assetType: "eip155:1/erc20:0x6b175474e89094c44da98b954eedeac495271d0f", symbol: "DAI", name: "Dai", decimals: 18, provenance: "user-imported", execution: "design-gate" }]
    };
    expect(validateAssetManifest(manifest).assets).toHaveLength(1);
    expect(() => validateAssetManifest({ ...manifest, assets: [{ ...manifest.assets[0], execution: "ready" }] })).toThrow("IMPORTED_ASSET_CANNOT_ENABLE_EXECUTION");
    expect(capabilitySummary().namespaces).toBeGreaterThan(10);
  });

  it("registers the injected wallet capabilities and the Bitcoin PSBT inspection", () => {
    expect(capabilitySummary().wallets).toBe(8);
    expect(WALLET_CAPABILITIES.some((wallet) => /walletconnect/i.test(wallet.id))).toBe(false);
    expect(WALLET_CAPABILITIES.find((wallet) => wallet.id === "bitcoin-psbt-v0-inspection")).toMatchObject({ state: "design-gate", grants: ["inspect-transaction"] });
  });

  it("writes every EVM address in the exact form ethers will accept", () => {
    // The 20 bytes are the same whatever the letter case, so a chain never
    // objects — but every path that normalizes an address does, and refuses the
    // whole call. Base Sepolia USDC was written with a wrong EIP-55 checksum and
    // sat unnoticed until a script passed it to a contract.
    const evmAssets = BUILT_IN_ASSETS.filter((asset) => asset.assetType.includes("/erc20:"));
    expect(evmAssets.length).toBeGreaterThan(0);
    const placeholders: string[] = [];
    for (const asset of evmAssets) {
      const address = asset.assetType.slice(asset.assetType.indexOf("/erc20:") + 7);
      // One entry is a deliberate stand-in for a token chosen at runtime. Skipping
      // anything unparseable would also skip a genuine typo, so the stand-ins are
      // named here rather than waved through.
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { placeholders.push(asset.assetType); continue; }
      expect(getAddress(address), asset.assetType).toBe(address);
    }
    expect(placeholders).toEqual(["eip155:31337/erc20:runtime-selected"]);
  });

  it("names Base Sepolia USDC by the address Circle publishes", () => {
    // The recorded address ended in "c" where Circle publishes "e", so nothing
    // was ever deployed at it. Two independent readers confirmed the published
    // one on 2026-09-05: 3,598 bytes of code, symbol USDC, six decimals —
    // artifacts-v01/base-sepolia-usdc-identity.json.
    // https://developers.circle.com/stablecoins/usdc-contract-addresses
    const usdc = BUILT_IN_ASSETS.find((asset) => asset.assetType.startsWith("eip155:84532/erc20:"));
    expect(usdc?.assetType).toBe("eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(usdc?.decimals).toBe(6);
  });
});
