export interface AgentTransfer { idempotencyKey: string; recipient: `0x${string}`; amountAtomic: string; note?: string }
export interface AgentPaymentResult { requestId: string; policyId: string; idempotencyKey: string; recipient: string; amountAtomic: string; state: 'reserved' | 'awaiting-approval' | 'signed' | 'cancelled' | 'failed-before-sign'; broadcastState: string | null; transactionHash: string | null; feeReservedWei: string; automaticRetry: false; error: string | null; receiptObservation?: {transactionReportedSuccessful: boolean | null; policySatisfied?: boolean; confirmations?: string; deliveryObserved?: boolean; observation?: string; observedAt?: number; matchingTransferEventObserved: boolean | null; observedEventAmountAtomic: string | null; actualBalanceChangeVerified: false; finalityVerified: false} | null; reconciliationObservation?: string | null }
export declare class AgentWalletClient {
  constructor(options: {url?: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch});
  status(): Promise<Record<string, unknown>>;
  balance(): Promise<Record<string, unknown>>;
  preview(input: AgentTransfer): Promise<AgentPaymentPreview | {alreadyRequested: true; result: AgentPaymentResult; reservationCreated: false; automaticRetry: false}>;
  transfer(input: AgentTransfer): Promise<AgentPaymentResult>;
  result(idempotencyKey: string, options?: {refresh?: boolean}): Promise<AgentPaymentResult | {state: 'not-found'; idempotencyKey: string; automaticRetry: false}>;
  history(): Promise<{requests: AgentPaymentResult[]}>;
  destroy(): void;
}

export interface AgentPaymentPreview { alreadyRequested: false; canRequest: true; idempotencyKey: string; policyId: string; account: string; chainId: string; asset: string; recipient: string; amountAtomic: string; executionFeeCapWei: string; totalNativeDebitCapWei: string; blockHash: string; expiresAt: number; mode: 'manual' | 'auto'; usage: Record<string, unknown>; reservationCreated: false; signatureCreated: false; automaticRetry: false; warning: string }
