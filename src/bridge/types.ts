export type ChainFamily = "evm" | "solana" | "cosmos" | "bitcoin" | "move" | "substrate" | "other";

export type RouteCategory = "evm-to-evm" | "evm-to-non-evm" | "non-evm-to-non-evm";

export type VerificationModel =
  | "canonical"
  | "light-client"
  | "guardian-attestation"
  | "issuer-attestation"
  | "oracle-network"
  | "validator-threshold"
  | "atomic-swap"
  | "liquidity-network";

export type RouteStatus = "verified" | "experimental" | "disabled";

export type ChainRef = {
  id: string;
  name: string;
  family: ChainFamily;
  nativeAsset: string;
  addressFormat: string;
  finalityLabel: string;
};

export type AssetRef = {
  chainId: string;
  assetId: string;
  symbol: string;
  decimals: number;
  representation: "native" | "canonical-wrapped" | "bridge-wrapped";
};

export type BridgeRoute = {
  id: string;
  revision: number;
  category: RouteCategory;
  status: RouteStatus;
  provider: string;
  mechanism: "lock-mint" | "burn-mint" | "lock-release" | "escrow-release" | "htlc";
  verificationModel: VerificationModel;
  source: ChainRef;
  destination: ChainRef;
  sourceEndpoint: string;
  destinationEndpoint: string;
  supportedAssets: AssetRef[];
  requiredSourceFinality: string;
  requiredDestinationFinality: string;
  recovery: "automatic-timeout" | "manual-claim" | "provider-support" | "none";
  reviewedAt: string;
  evidenceUrls: string[];
};

export type BridgeFee = {
  kind: "source-gas" | "destination-gas" | "protocol" | "relayer" | "liquidity";
  asset: string;
  amount: string;
  estimated: boolean;
};

export type BridgeQuote = {
  id: string;
  routeId: string;
  routeFingerprint: string;
  sourceAsset: AssetRef;
  destinationAsset: AssetRef;
  amountInBaseUnits: bigint;
  minimumOutBaseUnits: bigint;
  fees: BridgeFee[];
  recipient: string;
  expiresAt: number;
  estimatedSeconds: number | null;
};

export type BridgeStage =
  | "configuring"
  | "quote-ready"
  | "awaiting-approval"
  | "awaiting-source-wallet"
  | "source-submitted"
  | "source-finalized"
  | "awaiting-proof"
  | "destination-submitted"
  | "destination-finalized"
  | "delayed"
  | "refundable"
  | "failed"
  | "unknown";

export type BridgeTransfer = {
  transferId: string;
  stage: BridgeStage;
  quote: BridgeQuote;
  sourceTxId?: string;
  destinationTxId?: string;
  messageId?: string;
  lastUpdatedAt: number;
  detail?: string;
};

export interface BridgeAdapter {
  readonly adapterId: string;
  supports(route: BridgeRoute): boolean;
  quote(route: BridgeRoute, request: Omit<BridgeQuote, "id" | "routeFingerprint" | "fees" | "expiresAt" | "estimatedSeconds">): Promise<BridgeQuote>;
  submitSource(route: BridgeRoute, quote: BridgeQuote): Promise<BridgeTransfer>;
  refresh(route: BridgeRoute, transfer: BridgeTransfer): Promise<BridgeTransfer>;
  recover?(route: BridgeRoute, transfer: BridgeTransfer): Promise<BridgeTransfer>;
}
