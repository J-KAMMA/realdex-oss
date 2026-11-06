export interface LimitOrderRequest {requestKey:string;sender:string;subaccountId:string;side:'buy'|'sell';quantity:string;limitPrice:string;}
export interface UnsignedMessage {typeUrl:string;valueBase64:string;anyBase64:string;}
export interface UnsignedOrderPlan {
 schema:'realdex.injective-unsigned-order.v1';network:string;requestKey:string;clientOrderId:string;marketId:string;
 baseQuantityAtomic:string;input:LimitOrderRequest;message:UnsignedMessage;planSha256:string;
 signingEnabled:false;broadcastEnabled:false;executable:false;orderExpiryOnChain:null;
 blockers:string[];warnings:string[];
}
export function prepareInjectiveLimitOrder(snapshot:unknown,input:LimitOrderRequest,options?:{now?:number}):UnsignedOrderPlan;
export function prepareInjectiveCancelOrder(input:{sender:string;marketId:string;subaccountId:string;orderHash:string}):{
 schema:'realdex.injective-unsigned-cancel.v1';message:UnsignedMessage;signingEnabled:false;broadcastEnabled:false;executable:false;cancelled:false;warnings:string[];
};
export function orderProgress(plan:UnsignedOrderPlan,input:{filledBaseAtomic:string;status:'open'|'filled'|'cancel-pending'|'cancelled'|'unknown'}):{
 filledBaseAtomic:string;remainingBaseAtomic:string;status:string;reportedTerminal:boolean;remainingCanRest:boolean;reservationMayBeReleased:false;settlementVerified:false;automaticRetryAllowed:false;
};

/** Application revision is a canonical uint64 string, not an authenticated block height. */
export interface InjectiveOrderObservation {
 planSha256:string;clientOrderId:string;orderHash:string;revision:string;filledBaseAtomic:string;
 status:'open'|'filled'|'cancel-pending'|'cancelled'|'unknown';
}
export interface InjectiveObservedProgress extends InjectiveOrderObservation {
 schema:'realdex.injective-observed-progress.v1';remainingBaseAtomic:string;reportedTerminal:boolean;remainingCanRest:boolean;
 observationSha256:string;stateSha256:string;observationAuthenticated:false;
 reservationMayBeReleased:false;settlementVerified:false;automaticRetryAllowed:false;
 signingEnabled:false;broadcastEnabled:false;executable:false;
}
/** Self-check hashes are not signatures. State must come from the caller's own persisted sequence. */
export function reconcileInjectiveOrderObservation(plan:UnsignedOrderPlan,observation:InjectiveOrderObservation,previous?:InjectiveObservedProgress|null):{
 state:InjectiveObservedProgress;duplicate:boolean;
};
