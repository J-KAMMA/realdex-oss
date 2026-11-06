import type { CapabilityState } from "../universe/types";
import type { WalletExecutionGrant } from "../wallet/capabilities";

export type RouteOperation = "swap" | "bridge";

export type RouteDescriptor = {
  id: string;
  revision: number;
  operation: RouteOperation;
  adapterId: string;
  sourceAsset: string;
  destinationAsset: string;
  state: CapabilityState;
  walletCapabilityIds: string[];
  sourceExecutionTarget: string;
  executionMethod: string;
  maximumQuoteTtlMs: number;
  finalityTracking: "tracked" | "partial" | "none";
  trustBoundary: string;
  evidenceUrls: string[];
};

export type RouteQuoteRequest = {
  executionIntentId: string;
  sourceAsset: string;
  destinationAsset: string;
  amountInBaseUnits: bigint;
  accountId: string;
  recipient: string;
  walletCapabilityId: string;
  sessionRevision: number;
  walletGrant: WalletExecutionGrant;
  slippageBps: number;
};

export type RouteFee = {
  kind: "network" | "protocol" | "bridge" | "relayer" | "liquidity";
  asset: string;
  amountBaseUnits: bigint;
  estimated: boolean;
};

export type RouteQuote = {
  quoteId: string;
  routeId: string;
  routeFingerprint: string;
  requestFingerprint: string;
  adapterId: string;
  amountInBaseUnits: bigint;
  expectedOutBaseUnits: bigint;
  minimumOutBaseUnits: bigint;
  priceImpactBps?: number;
  fees: RouteFee[];
  unpricedCosts: string[];
  expiresAt: number;
  estimatedSeconds: number | null;
  authorization:
    | { type: "none" }
    | { type: "approval"; spender: string; amountBaseUnits: bigint; expiresAt: number | null }
    | { type: "adapter-managed"; detail: string };
  executionPreview: {
    chainId: string;
    target: string;
    method: string;
    valueBaseUnits: bigint;
  };
  adapterData: { format: string; value: unknown };
};

export type EvmTransactionEnvelopeEvidence = {
  from: string;
  to: string;
  nonce: number;
  data: string;
  valueBaseUnits: string;
  chainId: string;
};

export type EvmSubmittedTransactionEvidence = EvmTransactionEnvelopeEvidence & {
  observedBeforeBlock: number;
  replacement?: EvmTransactionEnvelopeEvidence & {
    hash: string;
    reason: "repriced" | "cancelled" | "replaced";
  };
};

export type EvmTransactionReceiptEvidence = {
  hash: string;
  status: 0 | 1;
  blockNumber: number;
  blockHash: string;
};

export type RouteExecutionFailureProof =
  | { type: "no-value-transfer-submitted" }
  | { type: "evm-value-transfer-reverted"; transactionHash: string }
  | { type: "cosmos-source-transaction-failed"; transactionHash: string; code: number };

export type RouteExecutionReceipt = {
  executionId: string;
  quoteId: string;
  state: "pending" | "confirmed" | "failed" | "unknown";
  provider: string;
  steps: Array<{
    name: string;
    state: string;
    kind?: "approval" | "swap" | "bridge";
    txHash?: string;
    evmTransaction?: EvmSubmittedTransactionEvidence;
    evmReceipt?: EvmTransactionReceiptEvidence;
    explorerUrl?: string;
    errorMessage?: string;
  }>;
  finality?: RouteFinalityRecord;
  failureProof?: RouteExecutionFailureProof;
};

export type RouteFinalityStage =
  | "source-submitted"
  | "source-included"
  | "awaiting-proof"
  | "destination-submitted"
  | "destination-observed"
  | "destination-confirmed"
  | "refundable"
  | "failed"
  | "unknown";

export type RouteFinalityCursor =
  | { protocol: "cctp-v2"; sourceDomain: number; destinationDomain: number; sourceTxCandidates: string[]; transferBinding?: import("../bridge/cctp-message").CctpTransferBinding }
  | { protocol: "ibc-ics20"; sourceTxHash: string; sequence: string; sourceChannel: string; destinationChannel: string; timeoutAt: number };

export type RouteFinalityEvidence = {
  kind: "source-tx" | "source-log" | "provider-message" | "destination-tx" | "destination-message" | "destination-mint" | "packet-ack";
  id: string;
  observedAt: number;
  url?: string;
  outcome?: "success" | "error";
};

export type RouteFinalityRecord = {
  schema: "localswap.finality.v1";
  executionId: string;
  quoteId: string;
  routeId: string;
  routeFingerprint: string;
  provider: string;
  stage: RouteFinalityStage;
  cursor: RouteFinalityCursor;
  evidence: RouteFinalityEvidence[];
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type RouteRejection = {
  routeId: string;
  code: string;
  detail?: string;
};

export type RouteSearchResult = {
  requestFingerprint: string;
  quotes: RouteQuote[];
  rejected: RouteRejection[];
};

export interface UniversalQuoteAdapter {
  readonly adapterId: string;
  supports(route: RouteDescriptor): boolean;
  quote(route: RouteDescriptor, request: RouteQuoteRequest): Promise<RouteQuote>;
}

export interface UniversalRouteAdapter extends UniversalQuoteAdapter {
  connectAccount(route: RouteDescriptor): Promise<string>;
  execute(route: RouteDescriptor, request: RouteQuoteRequest, quote: RouteQuote, onProgress?: (receipt: RouteExecutionReceipt) => void): Promise<RouteExecutionReceipt>;
}
