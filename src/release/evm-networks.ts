import { getAddress } from "ethers";
import registry from "./evm-networks.json";

/**
 * Selectable EVM networks. A network is listed here when its testnet (or mainnet)
 * counterpart is already supported by the rest of the code. The list carries chain
 * facts and well-known public RPC endpoints, never a contract address: Factory and
 * Router are deployed by each user and supplied by them.
 */
export type EvmNetworkEnvironment = "public-testnet" | "mainnet";
export type EvmNetworkId = keyof typeof registry.networks;
export type EvmNetworkInfo = {
  readonly id: EvmNetworkId;
  readonly name: string;
  readonly chainId: bigint;
  readonly environment: EvmNetworkEnvironment;
  readonly nativeSymbol: string;
  readonly counterpart: EvmNetworkId;
  readonly rpcUrls: readonly string[];
  readonly explorerAddressUrl: string;
};

export const EVM_NETWORKS: Readonly<Record<EvmNetworkId, EvmNetworkInfo>> = Object.freeze(
  Object.fromEntries((Object.entries(registry.networks) as [EvmNetworkId, (typeof registry.networks)[EvmNetworkId]][]).map(([id, item]) => [id, Object.freeze({
    id, name: item.name, chainId: BigInt(item.chainId), environment: item.environment as EvmNetworkEnvironment, nativeSymbol: item.nativeSymbol,
    counterpart: item.counterpart as EvmNetworkId, rpcUrls: Object.freeze([...item.rpcUrls]), explorerAddressUrl: item.explorerAddressUrl
  })])) as Record<EvmNetworkId, EvmNetworkInfo>
);

export function isEvmNetworkId(value: unknown): value is EvmNetworkId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EVM_NETWORKS, value);
}

export function evmNetworkByChainId(chainId: string | number | bigint): EvmNetworkInfo | undefined {
  try {
    const wanted = BigInt(chainId);
    return Object.values(EVM_NETWORKS).find((network) => network.chainId === wanted);
  } catch { return undefined; }
}

export function isMainnetChainId(chainId: string | number | bigint): boolean {
  return evmNetworkByChainId(chainId)?.environment === "mainnet";
}

/** User-supplied settings for one network. Every field is optional and nothing is persisted here. */
export type EvmNetworkOverride = { rpcUrls?: readonly string[]; factory?: string; router?: string };
export type ResolvedEvmNetwork = {
  network: EvmNetworkInfo;
  rpcUrls: string[];
  contracts: { factory: string; router: string } | null;
};

type EnvLike = Record<string, string | undefined>;

function viteEnv(): EnvLike {
  try { return (import.meta as unknown as { env?: EnvLike }).env ?? {}; } catch { return {}; }
}

/**
 * RPC endpoints: user override, then `VITE_REALDEX_RPC_<chainId>` (comma separated),
 * then the well-known public endpoints. All of them stay replaceable.
 */
export function resolveEvmNetwork(id: EvmNetworkId, override: EvmNetworkOverride = {}, env: EnvLike = viteEnv()): ResolvedEvmNetwork {
  const network = EVM_NETWORKS[id];
  if (!network) throw new Error("NETWORK_UNKNOWN");
  const fromEnv = (env[`VITE_REALDEX_RPC_${network.chainId}`] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const rpcUrls = override.rpcUrls?.length ? [...override.rpcUrls] : fromEnv.length ? fromEnv : [...network.rpcUrls];
  const factory = override.factory?.trim();
  const router = override.router?.trim();
  const contracts = factory && router ? { factory: checksum(factory), router: checksum(router) } : null;
  if (contracts && contracts.factory === contracts.router) throw new Error("NETWORK_CONTRACTS_NOT_DISTINCT");
  return { network, rpcUrls, contracts };
}

/**
 * The swap screens refuse a mainnet that has no Factory (and, for deposits, Router)
 * supplied by the user. There is deliberately no built-in fallback address.
 */
export function assertContractsConfigured(chainId: string | number | bigint, factory: string | undefined): void {
  if (isMainnetChainId(chainId) && !factory?.trim()) throw new Error("NETWORK_CONTRACTS_NOT_CONFIGURED");
}

export function networkContractsMessage(network: EvmNetworkInfo): string {
  return `No Factory/Router is configured for ${network.name} (${network.id}). Deploy your own with scripts/deployEvm.mjs, or enter the addresses of contracts you trust, then verify them.`;
}

function checksum(value: string): string {
  try { return getAddress(value); } catch { throw new Error("NETWORK_CONTRACT_ADDRESS_INVALID"); }
}