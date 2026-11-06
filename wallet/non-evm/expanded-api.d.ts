/** All amounts are integer strings. Preparation/approval endpoints are OWNER-ONLY. */
export type AtomicAmount = `${bigint}`;
export interface BitcoinUtxo { txid: string; vout: number; amountAtomic: AtomicAmount; scriptHex: string }
export interface BitcoinOfflinePayment {
  requestKey: string; networkId: 'bitcoin:regtest'; to: string;
  amountAtomic: AtomicAmount; feeAtomic: AtomicAmount; maxFeeRateSatVb: AtomicAmount;
  utxos: BitcoinUtxo[]; acknowledgeUnverifiedState: true;
}
export interface CosmosOfflinePayment {
  requestKey: string; chainId: `realdex-local-${string}`; hrp: string; to: string;
  denom: string; amountAtomic: AtomicAmount; feeDenom: string; feeAtomic: AtomicAmount;
  gasLimit: AtomicAmount; accountNumber: AtomicAmount; sequence: AtomicAmount;
  timeoutHeight: AtomicAmount; memo?: string; acknowledgeUnverifiedState: true;
}
export interface StellarOfflinePayment {
  requestKey: string; networkPassphrase: 'Standalone Network ; February 2017'; to: string;
  amountAtomic: AtomicAmount; feeAtomic: AtomicAmount; sequence: AtomicAmount;
  maxTime: AtomicAmount; memo?: string; acknowledgeUnverifiedState: true;
}
export interface AptosOfflinePayment {
  requestKey: string; chainId: 4; to: string; amountAtomic: AtomicAmount;
  sequence: AtomicAmount; maxGasAmount: AtomicAmount; gasUnitPrice: AtomicAmount;
  expirationTimestampSecs: AtomicAmount; acknowledgeUnverifiedState: true;
}
export type SplPayment = {
  requestKey: string; mint: string; source: string; destination: string; to: string;
} & ({amount: string; amountAtomic?: never}|{amountAtomic: AtomicAmount; amount?: never});
export type OfflineFamily = 'bitcoin'|'cosmos'|'stellar'|'aptos';
export interface NonEvmApproval { id: string; intentId: string; confirmation: string; broadcast: boolean }
/** broadcast MUST be false for offline families. Setting true always fails. */
export type OfflineApproval = Omit<NonEvmApproval,'broadcast'> & {broadcast: false};
