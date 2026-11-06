/** Owner-only local REST paths; no agent/MCP permissions are added. */
export interface AccountNetwork {
  family: "stellar" | "aptos";
  id: "stellar:standalone" | "aptos:local-4";
  name: string;
  rpcUrls: string[];
  checkpoint: {height: number; hash: string};
  broadcastEnabled: boolean;
  maxTransferAtomic: string;
  maxFeeAtomic: string;
  minConfirmations: number;
  networkPassphrase?: "Standalone Network ; February 2017";
  chainId?: 4;
}
export interface StellarOnlinePayment {
  requestKey: string; to: string; amount: string; feeAtomic: string; memo?: string;
}
export interface AptosOnlinePayment {
  requestKey: string; to: string; amount: string; maxGasAmount: string; gasUnitPrice: string;
}
export interface AccountOnlinePrepare {
  accountId: string; networkId: AccountNetwork["id"]; payment: StellarOnlinePayment | AptosOnlinePayment;
}
export interface AccountOnlineApproval {id: string; intentId: string; confirmation: string; broadcast: boolean}
export interface AccountOnlineSubmit {id: string; confirmation: string}
export interface AccountOnlineReport {
  observedAt: number; received: boolean; reason: string; finalityProven: false;
  assurance: "RPC observation only; no consensus/finality proof";
  ledger?: number; ledgerHash?: string; version?: string; feeAtomic?: string;
  balanceDeltaVerified?: boolean; transferObserved?: boolean;
  confirmations?: number; requiredConfirmations?: number;
}
