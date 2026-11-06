/** Owner-only JSON API DTOs. Amounts are canonical decimal strings, never floating point. */
export interface BitcoinRegtestNetwork {
 family: 'bitcoin'; id: 'bitcoin:regtest'; name: string; chain: 'regtest';
 genesisHash: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
 checkpoint: {height: number; hash: string}; rpcUrls: string[];
 /** Absolute local path; cookie content is never returned. */ cookieFile: string;
 broadcastEnabled: boolean; maxTransferSats: string; maxFeeSats: string; maxFeeRateSatVb: string;
 minConfirmations: number;
}
export interface BitcoinInput {txid: string; vout: number; amountAtomic: string; scriptHex: string}
export interface BitcoinPaymentBase {requestKey: string; to: string; feeAtomic: string; maxFeeRateSatVb: string; utxos: BitcoinInput[]}
export type BitcoinPayment = BitcoinPaymentBase & ({amount: string; amountAtomic?: never}|{amountAtomic: string; amount?: never});
export interface BitcoinPrepare {accountId: string; networkId: 'bitcoin:regtest'; payment: BitcoinPayment}
export interface BitcoinObservedInput extends BitcoinInput {height: number; confirmations: number; coinbase: boolean; reserved: boolean; eligible: boolean; spentInMempool: boolean}
export interface BitcoinUtxos {networkId: 'bitcoin:regtest'; address: string; head: {height: number; hash: string}; utxos: BitcoinObservedInput[]; totalConfirmedSats: string; eligibleSats: string; assurance: string; observedAt: number}
export interface BitcoinObservation {observedAt: number; received: boolean; reason: string; assurance: string; confirmations?: number; requiredConfirmations?: number; blockHash?: string|null; blockHeight?: number|null; inclusion?: boolean; feeAtomic?: string; finalityProven?: false}
export interface BitcoinOwnerRoutes {
 'non-evm/bitcoin-online/networks/add': {network: BitcoinRegtestNetwork; confirmation: string};
 'non-evm/bitcoin-online/utxos': {accountId: string; networkId: 'bitcoin:regtest'};
 'non-evm/bitcoin-online/prepare': BitcoinPrepare;
 'non-evm/bitcoin-online/submit': {id: string; confirmation: string};
 'non-evm/bitcoin-online/reconcile': {id: string};
}
