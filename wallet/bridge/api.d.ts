import type {Atomic,CosmosNetwork} from '../non-evm/cosmos-api';
/** Runtime accepts only reviewed local chain IDs and loopback endpoints. */
export interface IbcSide {network:CosmosNetwork;channel:`channel-${number}`;connection:`connection-${number}`;client:`07-tendermint-${number}`}
export interface IbcRoute {schema:'realdex.ibc-route.v1';id:`ibc-${string}`;name:string;source:IbcSide;destination:IbcSide;asset:{baseDenom:string;originChainId:CosmosNetwork['chainId'];decimals:number;symbol:string};maxTransferAtomic:Atomic;minTimeoutSeconds:number;maxTimeoutSeconds:number}
export type IbcPayment={requestKey:string;receiver:string;feeAtomic:Atomic;gasLimit:Atomic;timeoutSeconds:number}&({amount:string;amountAtomic?:never}|{amountAtomic:Atomic;amount?:never});
export interface IbcPrepare {accountId:string;routeId:IbcRoute['id'];payment:IbcPayment}
export interface IbcApprove {id:string;intentId:string;confirmation:string;broadcast:boolean}
export interface IbcReconcile {id:string;destinationTxHash?:string;settlementTxHash?:string}
export interface IbcPacket {sequence:Atomic;source_port:'transfer';source_channel:string;destination_port:'transfer';destination_channel:string;data:string;timeout_height:{revision_number:'0';revision_height:'0'};timeout_timestamp:Atomic}
export type IbcStage='signed'|'source-unresolved'|'awaiting-receive'|'awaiting-ack'|'awaiting-refund'|'reported-delivered'|'reported-refunded'|'source-failed'|'inconsistent';
export interface IbcObservation {observedAt:number;stage:IbcStage;received:boolean;refunded:boolean;completed:boolean;reason:string;assurance:string;finalityProven:false;stateProofVerified:false;timeoutElapsed:boolean;evidenceRefs:{destinationTxHash?:string;settlementTxHash?:string};packet?:IbcPacket;acknowledgement?:string;refundDeltaAtomic?:Atomic;settlementKind?:'acknowledge'|'timeout'}
/** This is a public packet plan only; it cannot sign, unlock, or release funds. */
export interface IbcRelayPlan {protocol:'ibc-classic-ics20-v1';packet:IbcPacket;route:IbcRoute;sourceTxHash:string;privateKeysIncluded:false;signingAuthority:false;timeoutRequiresNonReceiptProof:true;advisoryOnly:true}

/** Search is a candidate source only; every discovered hash is revalidated before persistence. */
export interface IbcTrack {id:string}
export interface IbcMonitorStart {ids:string[];intervalMs?:number}
export interface IbcMonitorEntry {id:string;nextAt:number;lastAt:number|null;checks:number;failures:number;stage:IbcStage|null;error:string|null}
export interface IbcMonitorStatus {enabled:boolean;running:boolean;reason:string;intervalMs:number;readOnly:true;signingAuthority:false;relayTransactions:false;requiresUnlockedVault:true;autoResume:false;entries:IbcMonitorEntry[]}
