import { describe, expect, it, vi } from "vitest";

const factoryCode = "0x6000";
const routerCode = "0x6001";
const factoryHash = "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d";
const routerHash = "0x309c67890bde4c575dc23d2cc3b5c3a3d599e312e980e9b61b5bc8f3cd87c8bb";

vi.mock("../swap/local-amm-code-identities.json", () => ({
  default: {
    schema: "localswap.evm-code-identities.v1", solidity: "0.8.24", optimizerRuns: 500,
    factoryRuntimeCodeHash: "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d",
    routerRuntimeCodeHash: "0x309c67890bde4c575dc23d2cc3b5c3a3d599e312e980e9b61b5bc8f3cd87c8bb"
  }
}));

import { validatePublicTestnetDeploymentManifest, verifyPublicTestnetDeployment, type EvmDeploymentReader } from "./evm-public-testnet";

const factoryAddress = "0x1111111111111111111111111111111111111111";
const routerAddress = "0x2222222222222222222222222222222222222222";
const factoryTx = `0x${"a".repeat(64)}`;
const routerTx = `0x${"b".repeat(64)}`;

function manifest() {
  return {
    schema: "realdex.evm-public-testnet-deployment.v1",
    releaseId: "base-sepolia-2026-09-01-a",
    environment: "public-testnet",
    network: { caip2: "eip155:84532", name: "Base Sepolia" },
    source: { bundleSha256: `sha256:${"c".repeat(64)}`, solidity: "0.8.24", optimizerRuns: 500, factoryRuntimeCodeHash: factoryHash, routerRuntimeCodeHash: routerHash },
    deployer: "0x3333333333333333333333333333333333333333",
    contracts: {
      factory: { address: factoryAddress, deploymentTxHash: factoryTx, blockNumber: 100, runtimeCodeHash: factoryHash },
      router: { address: routerAddress, deploymentTxHash: routerTx, blockNumber: 101, runtimeCodeHash: routerHash }
    },
    createdAt: Date.now(),
    evidenceUrls: ["https://example.invalid/source", "https://example.invalid/build"]
  };
}

function reader(id: string, change: Partial<{ chainId: bigint; blockNumber: number; factoryCode: string; routerCode: string; factoryReceiptAddress: string; routerReceiptStatus: "success" | "failed" }> = {}): EvmDeploymentReader {
  return {
    id,
    chainId: async () => change.chainId ?? 84532n,
    blockNumber: async () => change.blockNumber ?? 120,
    code: async (address) => address.toLowerCase() === factoryAddress.toLowerCase() ? change.factoryCode ?? factoryCode : change.routerCode ?? routerCode,
    deploymentReceipt: async (txHash) => txHash === factoryTx
      ? { status: "success", contractAddress: change.factoryReceiptAddress ?? factoryAddress, blockNumber: 100 }
      : { status: change.routerReceiptStatus ?? "success", contractAddress: routerAddress, blockNumber: 101 }
  };
}

describe("EVM public-testnet deployment release gate", () => {
  it("accepts only the exact reviewed source and Base Sepolia identity", () => {
    expect(validatePublicTestnetDeploymentManifest(manifest())).toMatchObject({ environment: "public-testnet", network: { caip2: "eip155:84532", name: "Base Sepolia" } });
    expect(() => validatePublicTestnetDeploymentManifest({ ...manifest(), network: { caip2: "eip155:1", name: "Ethereum" } })).toThrow("DEPLOYMENT_NETWORK_NOT_ALLOWED");
    expect(() => validatePublicTestnetDeploymentManifest({ ...manifest(), network: { caip2: "eip155:8453", name: "Base Mainnet" } })).toThrow("DEPLOYMENT_NETWORK_IDENTITY_MISMATCH");
    expect(() => validatePublicTestnetDeploymentManifest({ ...manifest(), environment: "mainnet" })).toThrow("DEPLOYMENT_ENVIRONMENT_MISMATCH");
    expect(() => validatePublicTestnetDeploymentManifest({ ...manifest(), environment: "staging" })).toThrow("DEPLOYMENT_MANIFEST_IDENTITY_INVALID");
  });

  it.each([["eip155:8453", "Base", 8453n], ["eip155:42161", "Arbitrum One", 42161n]])("accepts and verifies a user-deployed manifest on %s", async (caip2, name, chainId) => {
    const user = { ...manifest(), schema: "realdex.evm-deployment.v1", environment: "mainnet", network: { caip2, name } };
    expect(validatePublicTestnetDeploymentManifest(user)).toMatchObject({ environment: "mainnet", network: { caip2, name } });
    const result = await verifyPublicTestnetDeployment(user, [reader("a", { chainId }), reader("b", { chainId })], 1_800_000_000_000);
    expect(result).toMatchObject({ status: "verified", network: caip2 });
    // A reader that answers for the other chain is refused.
    await expect(verifyPublicTestnetDeployment(user, [reader("a", { chainId }), reader("b")])).rejects.toThrow("DEPLOYMENT_RPC_CHAIN_MISMATCH");
  });

  it("rejects changed code identities, unknown fields, weak evidence, and reused deployment identities", () => {
    const changedSource = { ...manifest(), source: { ...manifest().source, optimizerRuns: 200 } };
    expect(() => validatePublicTestnetDeploymentManifest(changedSource)).toThrow("DEPLOYMENT_SOURCE_IDENTITY_MISMATCH");
    expect(() => validatePublicTestnetDeploymentManifest({ ...manifest(), privateKey: "must-never-be-accepted" })).toThrow("DEPLOYMENT_MANIFEST_INVALID");
    expect(() => validatePublicTestnetDeploymentManifest({ ...manifest(), evidenceUrls: ["https://example.invalid/only-one"] })).toThrow("DEPLOYMENT_EVIDENCE_INVALID");
    const reused = manifest(); reused.contracts.router = { ...reused.contracts.router, address: factoryAddress };
    expect(() => validatePublicTestnetDeploymentManifest(reused)).toThrow("DEPLOYMENT_CONTRACTS_NOT_DISTINCT");
  });

  it("requires two independent observations of chain, receipts, and exact runtime code", async () => {
    const result = await verifyPublicTestnetDeployment(manifest(), [reader("rpc-a"), reader("rpc-b")], 1_800_000_000_000);
    expect(result).toMatchObject({ status: "verified", network: "eip155:84532", factoryAddress, routerAddress });
    expect(result.observations.map((item) => item.readerId)).toEqual(["rpc-a", "rpc-b"]);
    await expect(verifyPublicTestnetDeployment(manifest(), [reader("only")])).rejects.toThrow("DEPLOYMENT_RPC_QUORUM_INVALID");
    await expect(verifyPublicTestnetDeployment(manifest(), [reader("same"), reader("same")])).rejects.toThrow("DEPLOYMENT_RPC_QUORUM_INVALID");
  });

  it("fails closed on wrong chain, lagging RPC, changed bytecode, or failed deployment receipt", async () => {
    await expect(verifyPublicTestnetDeployment(manifest(), [reader("a"), reader("b", { chainId: 8453n })])).rejects.toThrow("DEPLOYMENT_RPC_CHAIN_MISMATCH");
    await expect(verifyPublicTestnetDeployment(manifest(), [reader("a"), reader("b", { blockNumber: 100 })])).rejects.toThrow("DEPLOYMENT_RPC_BEHIND");
    await expect(verifyPublicTestnetDeployment(manifest(), [reader("a"), reader("b", { routerCode: "0x6002" })])).rejects.toThrow("DEPLOYMENT_RUNTIME_CODE_MISMATCH");
    await expect(verifyPublicTestnetDeployment(manifest(), [reader("a"), reader("b", { routerReceiptStatus: "failed" })])).rejects.toThrow("DEPLOYMENT_RECEIPT_INVALID");
    await expect(verifyPublicTestnetDeployment(manifest(), [reader("a"), reader("b", { factoryReceiptAddress: routerAddress })])).rejects.toThrow("DEPLOYMENT_RECEIPT_INVALID");
  });

  it("refuses a chain that answers with the right number and the wrong contracts", async () => {
    // A local node can be told to report 84532, and since 2026-09-05 ours does.
    // Two readers pointed at it agree with each other and report the expected
    // chain — every check that compares readers to each other passes. What must
    // still refuse is the comparison against the reviewed code itself, because
    // identity is the contract, not the number in front of it.
    const impostor = { factoryCode: "0x60ff", routerCode: "0x60fe" };
    await expect(verifyPublicTestnetDeployment(manifest(), [reader("local-a", impostor), reader("local-b", impostor)]))
      .rejects.toThrow("DEPLOYMENT_RUNTIME_CODE_MISMATCH");
    // And the ordinary case of pointing at a chain where nothing is deployed,
    // which is refused earlier and more precisely: there is no code to compare.
    const empty = { factoryCode: "0x", routerCode: "0x" };
    await expect(verifyPublicTestnetDeployment(manifest(), [reader("bare-a", empty), reader("bare-b", empty)]))
      .rejects.toThrow("DEPLOYMENT_RUNTIME_CODE_MISSING");
  });
});
