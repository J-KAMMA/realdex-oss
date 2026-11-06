/** Owner-only local developer API. No mainnet or agent authority is implied. */
export type Atomic = `${bigint}`;
export interface CosmosNetwork {
 family:'cosmos'; id:`cosmos:realdex-local-${string}`; name:string;
 chainId:`realdex-local-${string}`; hrp:string;
 endpoints:ReadonlyArray<{rpcUrl:string;restUrl:string}>;
 checkpoint:{height:number;hash:string}; denom:string;decimals:number;symbol:string;
 feeDenom:string;feeDecimals:number;maxTransferAtomic:Atomic;maxFeeAtomic:Atomic;
 maxGasLimit:Atomic;timeoutBlocks:number;minConfirmations:number;broadcastEnabled:boolean;
}
export type CosmosPayment = {requestKey:string;to:string;feeAtomic:Atomic;gasLimit:Atomic;memo?:string} &
 ({amount:string;amountAtomic?:never}|{amountAtomic:Atomic;amount?:never});
export interface CosmosPrepare {accountId:string;networkId:CosmosNetwork['id'];payment:CosmosPayment}
export interface CosmosSubmit {id:string;confirmation:string}
export interface CosmosObservation {
 observedAt:number;received:boolean;reason:string;assurance:string;finalityProven:false;
 height?:number;blockHash?:string;feeAtomic?:Atomic;gasUsed?:Atomic;code?:number;
 inclusionVerified?:boolean;headerHashVerified?:false;stateProofVerified?:false;
 balanceDeltaVerified?:false;transferObserved?:boolean;confirmations?:number;requiredConfirmations?:number;
}
