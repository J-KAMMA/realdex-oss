export type CapabilityState = "ready" | "partial" | "design-gate";

export type UniversalOperation =
  | "connect-wallet"
  | "read-assets"
  | "quote-swap"
  | "execute-swap"
  | "bridge"
  | "track-finality";

export type ChainNamespace = {
  namespace: string;
  label: string;
  examples: string[];
  addressModel: string;
  walletStandard: string;
  operations: Partial<Record<UniversalOperation, CapabilityState>>;
  adapterIds?: Partial<Record<UniversalOperation, string>>;
};

export type WalletCapability = {
  id: string;
  name: string;
  namespaces: string[];
  transport: "injected" | "session" | "mobile-link" | "hardware" | "file";
  state: CapabilityState;
  grants: Array<"inspect-session" | "inspect-transaction" | "connect" | "sign-message" | "approve" | "sign-transaction" | "broadcast">;
};

export type UniversalAsset = {
  assetType: string;
  symbol: string;
  name: string;
  decimals: number;
  provenance: "built-in-reviewed" | "signed-list" | "on-chain-read" | "user-imported";
  execution: CapabilityState;
};

export type AssetManifest = {
  schema: "localswap.asset-manifest.v1";
  name: string;
  revision: number;
  assets: UniversalAsset[];
  evidenceUrls: string[];
};
