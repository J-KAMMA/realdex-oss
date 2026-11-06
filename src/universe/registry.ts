import type { AssetManifest, CapabilityState, ChainNamespace, UniversalAsset, UniversalOperation, WalletCapability } from "./types";

const READY: Partial<Record<UniversalOperation, CapabilityState>> = {
  "connect-wallet": "ready", "read-assets": "ready", "quote-swap": "ready", "execute-swap": "ready", bridge: "ready", "track-finality": "partial"
};
const SOLANA_BOUNDARY: Partial<Record<UniversalOperation, CapabilityState>> = {
  "connect-wallet": "ready", "read-assets": "partial", "quote-swap": "partial", "execute-swap": "design-gate", bridge: "ready", "track-finality": "partial"
};
const COSMOS_BOUNDARY: Partial<Record<UniversalOperation, CapabilityState>> = {
  "connect-wallet": "partial", "read-assets": "partial", "quote-swap": "partial", "execute-swap": "design-gate", bridge: "ready", "track-finality": "partial"
};
const PLANNED: Partial<Record<UniversalOperation, CapabilityState>> = {
  "connect-wallet": "design-gate", "read-assets": "design-gate", "quote-swap": "design-gate", "execute-swap": "design-gate", bridge: "design-gate", "track-finality": "design-gate"
};

export const CHAIN_NAMESPACES: ChainNamespace[] = [
  { namespace: "eip155", label: "EVM", examples: ["Ethereum", "Base", "Arbitrum", "Avalanche", "BNB Chain"], addressModel: "0x / EIP-55", walletStandard: "EIP-1193", operations: READY, adapterIds: { "quote-swap": "evm-local-amm", "execute-swap": "evm-local-amm", bridge: "cctp-v2", "track-finality": "cctp-v2" } },
  { namespace: "solana", label: "Solana / SVM", examples: ["Solana", "SVM networks"], addressModel: "base58 public key", walletStandard: "Wallet Standard", operations: SOLANA_BOUNDARY, adapterIds: { "quote-swap": "solana-swap-boundary", "execute-swap": "solana-swap-boundary", bridge: "cctp-v2", "track-finality": "cctp-v2" } },
  { namespace: "cosmos", label: "Cosmos / IBC", examples: ["Cosmos Hub", "Osmosis", "Noble", "Neutron"], addressModel: "chain bech32", walletStandard: "Cosmos injected signer", operations: COSMOS_BOUNDARY, adapterIds: { "quote-swap": "cosmos-swap-boundary", "execute-swap": "cosmos-swap-boundary", bridge: "ibc-ics20", "track-finality": "ibc-ics20" } },
  { namespace: "bip122", label: "Bitcoin-like", examples: ["Bitcoin", "Litecoin"], addressModel: "network script/address", walletStandard: "PSBT", operations: PLANNED },
  { namespace: "polkadot", label: "Substrate", examples: ["Polkadot", "Kusama", "Asset Hub"], addressModel: "SS58", walletStandard: "Injected extension", operations: PLANNED },
  { namespace: "aptos", label: "Aptos / Move", examples: ["Aptos"], addressModel: "32-byte account", walletStandard: "Aptos Wallet Standard", operations: PLANNED },
  { namespace: "sui", label: "Sui / Move", examples: ["Sui"], addressModel: "32-byte object/account", walletStandard: "Wallet Standard", operations: PLANNED },
  { namespace: "starknet", label: "Starknet", examples: ["Starknet"], addressModel: "felt address", walletStandard: "Starknet wallet API", operations: PLANNED },
  { namespace: "near", label: "NEAR", examples: ["NEAR"], addressModel: "named or implicit account", walletStandard: "Wallet Selector", operations: PLANNED },
  { namespace: "cardano", label: "Cardano", examples: ["Cardano"], addressModel: "CIP address", walletStandard: "CIP-30", operations: PLANNED },
  { namespace: "tron", label: "TRON", examples: ["TRON"], addressModel: "base58check / hex", walletStandard: "Injected provider", operations: PLANNED },
  { namespace: "xrpl", label: "XRPL", examples: ["XRP Ledger"], addressModel: "classic / X-address", walletStandard: "Wallet session", operations: PLANNED },
  { namespace: "algorand", label: "Algorand", examples: ["Algorand"], addressModel: "32-byte address", walletStandard: "Wallet session", operations: PLANNED },
  { namespace: "tezos", label: "Tezos", examples: ["Tezos"], addressModel: "tz / KT", walletStandard: "Beacon", operations: PLANNED }
];

export const WALLET_CAPABILITIES: WalletCapability[] = [
  { id: "eip1193", name: "EIP-6963 discovered EIP-1193 wallets", namespaces: ["eip155"], transport: "injected", state: "ready", grants: ["connect", "sign-message", "approve", "sign-transaction", "broadcast"] },
  { id: "solana-wallet-standard", name: "Solana Wallet Standard", namespaces: ["solana"], transport: "injected", state: "partial", grants: ["connect", "sign-message", "sign-transaction", "broadcast"] },
  { id: "cosmos-injected", name: "Keplr-compatible Cosmos signer", namespaces: ["cosmos"], transport: "injected", state: "partial", grants: ["connect", "sign-message", "sign-transaction", "broadcast"] },
  { id: "bitcoin-psbt", name: "Bitcoin PSBT wallets", namespaces: ["bip122"], transport: "file", state: "design-gate", grants: ["connect", "sign-transaction", "broadcast"] },
  { id: "bitcoin-psbt-v0-inspection", name: "Bitcoin PSBT v0 exact-intent inspection", namespaces: ["bip122"], transport: "file", state: "design-gate", grants: ["inspect-transaction"] },
  { id: "hardware", name: "Hardware wallets", namespaces: ["eip155", "bip122", "cosmos", "solana", "cardano", "polkadot"], transport: "hardware", state: "design-gate", grants: ["connect", "sign-message", "sign-transaction"] },
  { id: "move-wallets", name: "Move ecosystem wallets", namespaces: ["aptos", "sui"], transport: "injected", state: "design-gate", grants: ["connect", "sign-message", "sign-transaction", "broadcast"] },
  { id: "ecosystem-wallets", name: "Native ecosystem wallet APIs", namespaces: ["polkadot", "starknet", "near", "cardano", "tron", "xrpl", "algorand", "tezos"], transport: "injected", state: "design-gate", grants: ["connect", "sign-message", "sign-transaction", "broadcast"] }
];

export const BUILT_IN_ASSETS: UniversalAsset[] = [
  { assetType: "eip155:31337/erc20:runtime-selected", symbol: "ERC-20", name: "Runtime-selected local token", decimals: 18, provenance: "on-chain-read", execution: "ready" },
  { assetType: "eip155:84532/slip44:60", symbol: "ETH", name: "Base Sepolia gas asset", decimals: 18, provenance: "built-in-reviewed", execution: "ready" },
  { assetType: "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", name: "Base Sepolia USDC", decimals: 6, provenance: "built-in-reviewed", execution: "design-gate" },
  { assetType: "eip155:421614/slip44:60", symbol: "ETH", name: "Arbitrum Sepolia gas asset", decimals: 18, provenance: "built-in-reviewed", execution: "ready" },
  { assetType: "eip155:421614/erc20:0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", symbol: "USDC", name: "Arbitrum Sepolia USDC", decimals: 6, provenance: "built-in-reviewed", execution: "ready" },
  { assetType: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/slip44:501", symbol: "SOL", name: "Solana Devnet gas asset", decimals: 9, provenance: "built-in-reviewed", execution: "ready" },
  { assetType: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", name: "Solana Devnet USDC", decimals: 6, provenance: "built-in-reviewed", execution: "ready" },
  { assetType: "cosmos:grand-1/denom:uusdc", symbol: "USDC.n", name: "Noble Testnet USDC", decimals: 6, provenance: "built-in-reviewed", execution: "ready" },
  { assetType: "cosmos:osmo-test-5/denom:uosmo", symbol: "OSMO", name: "Osmosis Testnet gas asset", decimals: 6, provenance: "built-in-reviewed", execution: "ready" },
  { assetType: "cosmos:osmo-test-5/ibc:DE6792CF9E521F6AD6E9A4BDF6225C9571A3B74ACC0A529F92BC5122A39D2E58", symbol: "USDC.n", name: "Osmosis Testnet IBC USDC", decimals: 6, provenance: "built-in-reviewed", execution: "ready" }
];

export function isCaip2(value: string): boolean {
  return /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(value);
}

export function isCaip19(value: string): boolean {
  const [chain, asset] = splitOnce(value, "/");
  return Boolean(chain && asset && isCaip2(chain) && /^[-a-z0-9]{3,8}:[\-.%a-zA-Z0-9]{1,128}$/.test(asset));
}

export function validateAssetManifest(value: unknown): AssetManifest {
  if (!value || typeof value !== "object") throw new Error("ASSET_MANIFEST_OBJECT_REQUIRED");
  const manifest = value as Partial<AssetManifest>;
  if (manifest.schema !== "localswap.asset-manifest.v1") throw new Error("ASSET_MANIFEST_SCHEMA_UNSUPPORTED");
  if (!manifest.name || !Number.isInteger(manifest.revision) || Number(manifest.revision) <= 0) throw new Error("ASSET_MANIFEST_IDENTITY_INVALID");
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0 || manifest.assets.length > 10_000) throw new Error("ASSET_MANIFEST_SIZE_INVALID");
  if (!Array.isArray(manifest.evidenceUrls) || manifest.evidenceUrls.length === 0 || manifest.evidenceUrls.some((url) => !isHttpsUrl(url))) throw new Error("ASSET_MANIFEST_EVIDENCE_INVALID");
  const seen = new Set<string>();
  for (const asset of manifest.assets) {
    if (!asset || !isCaip19(asset.assetType) || !asset.symbol || !asset.name || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) throw new Error("ASSET_MANIFEST_TOKEN_INVALID");
    if (seen.has(asset.assetType)) throw new Error("ASSET_MANIFEST_DUPLICATE_ASSET");
    if (asset.execution !== "design-gate") throw new Error("IMPORTED_ASSET_CANNOT_ENABLE_EXECUTION");
    if (asset.provenance !== "user-imported" && asset.provenance !== "signed-list") throw new Error("ASSET_MANIFEST_PROVENANCE_INVALID");
    seen.add(asset.assetType);
  }
  return manifest as AssetManifest;
}

export function capabilitySummary() {
  const operations = CHAIN_NAMESPACES.flatMap((chain) => Object.values(chain.operations));
  return {
    namespaces: CHAIN_NAMESPACES.length,
    readyNamespaces: CHAIN_NAMESPACES.filter((chain) => chain.operations["connect-wallet"] === "ready").length,
    readyExecutionPaths: operations.filter((state) => state === "ready").length,
    wallets: WALLET_CAPABILITIES.length,
    builtInAssets: BUILT_IN_ASSETS.length
  };
}

function splitOnce(value: string, separator: string): [string, string] | [undefined, undefined] {
  const index = value.indexOf(separator);
  return index > 0 ? [value.slice(0, index), value.slice(index + 1)] : [undefined, undefined];
}

function isHttpsUrl(value: string) {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}
