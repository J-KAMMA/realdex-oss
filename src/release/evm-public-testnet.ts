import { getAddress, keccak256 } from "ethers";
import codeIdentities from "../swap/local-amm-code-identities.json";
import { EVM_NETWORKS, isEvmNetworkId, type EvmNetworkEnvironment, type EvmNetworkId } from "./evm-networks";

/** Every network a user may select. Name kept for existing imports; mainnets are included. */
export const PUBLIC_TESTNET_RELEASE_NETWORKS = EVM_NETWORKS;

export type PublicTestnetNetworkId = EvmNetworkId;

export const DEPLOYMENT_MANIFEST_SCHEMAS = ["realdex.evm-public-testnet-deployment.v1", "realdex.evm-deployment.v1"] as const;

export type EvmDeploymentContractEvidence = {
  address: string;
  deploymentTxHash: string;
  blockNumber: number;
  runtimeCodeHash: string;
};

export type EvmPublicTestnetDeploymentManifest = {
  schema: (typeof DEPLOYMENT_MANIFEST_SCHEMAS)[number];
  releaseId: string;
  environment: EvmNetworkEnvironment;
  network: { caip2: PublicTestnetNetworkId; name: string };
  source: {
    bundleSha256: string;
    solidity: string;
    optimizerRuns: number;
    factoryRuntimeCodeHash: string;
    routerRuntimeCodeHash: string;
  };
  deployer: string;
  contracts: { factory: EvmDeploymentContractEvidence; router: EvmDeploymentContractEvidence };
  createdAt: number;
  evidenceUrls: string[];
};

export type EvmDeploymentReceipt = {
  status: "success" | "failed";
  contractAddress: string | null;
  blockNumber: number;
};

export type EvmDeploymentReader = {
  id: string;
  chainId(): Promise<bigint>;
  blockNumber(): Promise<number>;
  code(address: string): Promise<string>;
  deploymentReceipt(transactionHash: string): Promise<EvmDeploymentReceipt | null>;
};

export type EvmDeploymentObservation = {
  readerId: string;
  chainId: bigint;
  observedBlock: number;
  factoryCodeHash: string;
  routerCodeHash: string;
};

export type VerifiedEvmPublicTestnetDeployment = {
  status: "verified";
  releaseId: string;
  network: PublicTestnetNetworkId;
  factoryAddress: string;
  routerAddress: string;
  verifiedAt: number;
  observations: EvmDeploymentObservation[];
};

const HEX_32 = /^0x[0-9a-f]{64}$/;
const SHA_256 = /^sha256:[0-9a-f]{64}$/;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function validatePublicTestnetDeploymentManifest(value: unknown, now = Date.now()): EvmPublicTestnetDeploymentManifest {
  const root = strictObject(value, ["schema", "releaseId", "environment", "network", "source", "deployer", "contracts", "createdAt", "evidenceUrls"], "DEPLOYMENT_MANIFEST_INVALID");
  if (!DEPLOYMENT_MANIFEST_SCHEMAS.includes(root.schema as (typeof DEPLOYMENT_MANIFEST_SCHEMAS)[number]) || (root.environment !== "public-testnet" && root.environment !== "mainnet") || typeof root.releaseId !== "string" || !RELEASE_ID.test(root.releaseId)) throw new Error("DEPLOYMENT_MANIFEST_IDENTITY_INVALID");

  const network = strictObject(root.network, ["caip2", "name"], "DEPLOYMENT_NETWORK_INVALID");
  if (!isEvmNetworkId(network.caip2)) throw new Error("DEPLOYMENT_NETWORK_NOT_ALLOWED");
  const networkId = network.caip2 as PublicTestnetNetworkId;
  const reviewedNetwork = PUBLIC_TESTNET_RELEASE_NETWORKS[networkId];
  if (network.name !== reviewedNetwork.name) throw new Error("DEPLOYMENT_NETWORK_IDENTITY_MISMATCH");
  if (root.environment !== reviewedNetwork.environment) throw new Error("DEPLOYMENT_ENVIRONMENT_MISMATCH");

  const source = strictObject(root.source, ["bundleSha256", "solidity", "optimizerRuns", "factoryRuntimeCodeHash", "routerRuntimeCodeHash"], "DEPLOYMENT_SOURCE_INVALID");
  if (typeof source.bundleSha256 !== "string" || !SHA_256.test(source.bundleSha256) || source.solidity !== codeIdentities.solidity || source.optimizerRuns !== codeIdentities.optimizerRuns || source.factoryRuntimeCodeHash !== codeIdentities.factoryRuntimeCodeHash || source.routerRuntimeCodeHash !== codeIdentities.routerRuntimeCodeHash) throw new Error("DEPLOYMENT_SOURCE_IDENTITY_MISMATCH");

  const contracts = strictObject(root.contracts, ["factory", "router"], "DEPLOYMENT_CONTRACTS_INVALID");
  const factory = validateContractEvidence(contracts.factory);
  const router = validateContractEvidence(contracts.router);
  if (factory.address === router.address || factory.deploymentTxHash === router.deploymentTxHash) throw new Error("DEPLOYMENT_CONTRACTS_NOT_DISTINCT");
  if (factory.runtimeCodeHash !== codeIdentities.factoryRuntimeCodeHash || router.runtimeCodeHash !== codeIdentities.routerRuntimeCodeHash) throw new Error("DEPLOYMENT_CODE_IDENTITY_MISMATCH");

  const deployer = normalizedAddress(root.deployer, "DEPLOYMENT_DEPLOYER_INVALID");
  if (!Number.isSafeInteger(root.createdAt) || Number(root.createdAt) <= 0 || Number(root.createdAt) > now + 5 * 60_000) throw new Error("DEPLOYMENT_TIME_INVALID");
  if (!Array.isArray(root.evidenceUrls) || root.evidenceUrls.length < 2 || root.evidenceUrls.length > 8 || root.evidenceUrls.some((url) => typeof url !== "string" || !isHttps(url)) || new Set(root.evidenceUrls).size !== root.evidenceUrls.length) throw new Error("DEPLOYMENT_EVIDENCE_INVALID");

  return {
    schema: root.schema as EvmPublicTestnetDeploymentManifest["schema"],
    releaseId: root.releaseId,
    environment: root.environment as EvmNetworkEnvironment,
    network: { caip2: networkId, name: reviewedNetwork.name },
    source: {
      bundleSha256: source.bundleSha256 as string,
      solidity: source.solidity as string,
      optimizerRuns: source.optimizerRuns as number,
      factoryRuntimeCodeHash: source.factoryRuntimeCodeHash as string,
      routerRuntimeCodeHash: source.routerRuntimeCodeHash as string
    },
    deployer,
    contracts: { factory, router },
    createdAt: root.createdAt as number,
    evidenceUrls: [...root.evidenceUrls] as string[]
  };
}

export async function verifyPublicTestnetDeployment(
  input: unknown,
  readers: readonly EvmDeploymentReader[],
  now = Date.now()
): Promise<VerifiedEvmPublicTestnetDeployment> {
  const manifest = validatePublicTestnetDeploymentManifest(input, now);
  if (readers.length < 2 || readers.length > 4 || readers.some((reader) => !reader.id.trim() || reader.id.length > 100) || new Set(readers.map((reader) => reader.id)).size !== readers.length) throw new Error("DEPLOYMENT_RPC_QUORUM_INVALID");
  const expectedChainId = PUBLIC_TESTNET_RELEASE_NETWORKS[manifest.network.caip2].chainId;
  const requiredBlock = Math.max(manifest.contracts.factory.blockNumber, manifest.contracts.router.blockNumber);

  const observations = await Promise.all(readers.map(async (reader): Promise<EvmDeploymentObservation> => {
    const [chainId, observedBlock, factoryCode, routerCode, factoryReceipt, routerReceipt] = await Promise.all([
      reader.chainId(), reader.blockNumber(), reader.code(manifest.contracts.factory.address), reader.code(manifest.contracts.router.address),
      reader.deploymentReceipt(manifest.contracts.factory.deploymentTxHash), reader.deploymentReceipt(manifest.contracts.router.deploymentTxHash)
    ]);
    if (chainId !== expectedChainId) throw new Error("DEPLOYMENT_RPC_CHAIN_MISMATCH");
    if (!Number.isSafeInteger(observedBlock) || observedBlock < requiredBlock) throw new Error("DEPLOYMENT_RPC_BEHIND");
    assertReceipt(factoryReceipt, manifest.contracts.factory);
    assertReceipt(routerReceipt, manifest.contracts.router);
    const factoryCodeHash = runtimeHash(factoryCode);
    const routerCodeHash = runtimeHash(routerCode);
    if (factoryCodeHash !== manifest.contracts.factory.runtimeCodeHash || routerCodeHash !== manifest.contracts.router.runtimeCodeHash) throw new Error("DEPLOYMENT_RUNTIME_CODE_MISMATCH");
    return { readerId: reader.id, chainId, observedBlock, factoryCodeHash, routerCodeHash };
  }));

  if (new Set(observations.map((item) => `${item.chainId}:${item.factoryCodeHash}:${item.routerCodeHash}`)).size !== 1) throw new Error("DEPLOYMENT_RPC_OBSERVATION_DIVERGED");
  return {
    status: "verified",
    releaseId: manifest.releaseId,
    network: manifest.network.caip2,
    factoryAddress: manifest.contracts.factory.address,
    routerAddress: manifest.contracts.router.address,
    verifiedAt: now,
    observations
  };
}

function validateContractEvidence(value: unknown): EvmDeploymentContractEvidence {
  const item = strictObject(value, ["address", "deploymentTxHash", "blockNumber", "runtimeCodeHash"], "DEPLOYMENT_CONTRACT_INVALID");
  const address = normalizedAddress(item.address, "DEPLOYMENT_CONTRACT_ADDRESS_INVALID");
  if (typeof item.deploymentTxHash !== "string" || !HEX_32.test(item.deploymentTxHash) || !Number.isSafeInteger(item.blockNumber) || Number(item.blockNumber) <= 0 || typeof item.runtimeCodeHash !== "string" || !HEX_32.test(item.runtimeCodeHash)) throw new Error("DEPLOYMENT_CONTRACT_EVIDENCE_INVALID");
  return { address, deploymentTxHash: item.deploymentTxHash, blockNumber: item.blockNumber as number, runtimeCodeHash: item.runtimeCodeHash };
}

function assertReceipt(receipt: EvmDeploymentReceipt | null, expected: EvmDeploymentContractEvidence): void {
  if (!receipt || receipt.status !== "success" || receipt.contractAddress === null || normalizedAddress(receipt.contractAddress, "DEPLOYMENT_RECEIPT_INVALID") !== expected.address || receipt.blockNumber !== expected.blockNumber) throw new Error("DEPLOYMENT_RECEIPT_INVALID");
}

function runtimeHash(code: string): string {
  if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || code === "0x") throw new Error("DEPLOYMENT_RUNTIME_CODE_MISSING");
  return keccak256(code).toLowerCase();
}

function normalizedAddress(value: unknown, code: string): string {
  try {
    if (typeof value !== "string" || value === "0x0000000000000000000000000000000000000000") throw new Error(code);
    return getAddress(value);
  } catch { throw new Error(code); }
}

function strictObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(code);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) throw new Error(code);
  return object;
}

function isHttps(value: string): boolean {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}
