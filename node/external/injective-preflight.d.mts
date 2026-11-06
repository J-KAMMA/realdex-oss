import type {LimitOrderRequest,UnsignedOrderPlan} from './injective-orders.mjs';
export interface InjectivePreflightPolicy {
 gasLimit:string; gasPriceAtomic:string; maxGasFeeAtomic:string;
 maxTradingFeeBps:number|string; gasMarginBps:number|string;
 timeoutBlocks:number|string; maxAgeMs:number|string;
}
export interface InjectivePreflightOptions {
 access?:{mode?:'local-only'|'explicit-remote';allowedOrigins?:string[]};
 signal?:AbortSignal;fetchImpl?:typeof fetch;now?:()=>number;timeoutMs?:number;
}
export interface InjectivePreflightRequest {
 snapshot:unknown;input:LimitOrderRequest;chainId:'injective-888';endpoint:string;
 publicKeyHex:string;policy:InjectivePreflightPolicy;
}
export interface InjectivePreflightReview {
 readonly schema:'realdex.injective-preflight.v1';readonly plan:UnsignedOrderPlan;
 readonly chainId:'injective-888';readonly queryApiVersion:'injective.exchange.v2';readonly endpoint:string;readonly reviewSha256:string;
 readonly observedAt:number;readonly expiresAt:number;
 readonly anchor:{readonly height:string;readonly hash:string;readonly time:string;readonly timeMs:number;readonly chainId:string};
 readonly account:{readonly address:string;readonly accountNumber:string;readonly sequence:string;readonly publicKeyHex:string};
 readonly spend:{readonly location:'bank-spendable-conservative'|'exchange-subaccount';readonly denom:string;readonly availableAtomic:string;readonly requiredAtomic:string;readonly gasSharesBalance:boolean};
 readonly transaction:{readonly bodyBytesBase64:string;readonly authInfoBytesBase64:string;readonly signDocBase64:string;readonly simulationTxBase64:string;readonly timeoutHeight:string;readonly signMode:'SIGN_MODE_DIRECT';readonly fee:{readonly denom:'inj';readonly amount:string;readonly gasLimit:string};readonly signatures:readonly []};
 readonly costs:{readonly gasAvailableAtomic:string;readonly gasFeeAtomic:string;readonly tradingFeeQuoteCapAtomic:string;readonly tradingFeeRateCap:{numerator:string;denominator:string};readonly gasPriceSource:'caller-selected-not-a-chain-quote';readonly tradingFeeCapEnforcedOnChain:false};
 readonly simulation:{readonly gasUsed:string;readonly gasWanted:string;readonly executedBy:'selected-endpoint-simulation';readonly authenticated:false};
 readonly receipts:readonly {method:string;path:string;height:string|null;responseSha256:string;requestSha256?:string}[];
 readonly policy:InjectivePreflightPolicy;readonly readyForOwnerReview:true;
 readonly ownerApproved:false;readonly chainStateAuthenticated:false;readonly signingEnabled:false;
 readonly broadcastEnabled:false;readonly executable:false;readonly settlementVerified:false;
 readonly blockers:readonly string[];readonly warnings:readonly string[];
}
export function preflightInjectiveLimitOrder(request:InjectivePreflightRequest,options?:InjectivePreflightOptions):Promise<InjectivePreflightReview>;
export function observeAndPreflightInjectiveOrder(request:Omit<InjectivePreflightRequest,'snapshot'|'chainId'>&{
 selection:{provider:'injective';network:'injective-888';endpoint:string;marketId:string};
},options?:InjectivePreflightOptions):Promise<InjectivePreflightReview>;
