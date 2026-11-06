export type Provider = 'injective' | 'hypercore';
export type Atomic = string;
export interface Asset { readonly id: string; readonly symbol: string; readonly decimals: number }
export interface Fraction { readonly numerator: string; readonly denominator: string }
export interface Market {
 readonly schema:'realdex.external-spot-market.v1'; readonly provider:Provider;
 readonly network:string; readonly id:string; readonly ticker:string; readonly base:Asset; readonly quote:Asset;
 readonly balanceLocation:string; readonly priceTick:Fraction; readonly lotAtomic:Atomic;
 readonly minNotionalQuote:Fraction; readonly minNotionalKnown:boolean; readonly takerFeeRate:Fraction|null;
 readonly feeSource:string; readonly decimalsSource:string; readonly orderRequirementsVerified:false;
}
export interface Snapshot {
 readonly schema:'realdex.external-spot-snapshot.v1'; readonly market:Market;
 readonly bids:readonly {readonly price:Fraction;readonly baseAtomic:Atomic}[];
 readonly asks:Snapshot['bids']; readonly serverTime:number; readonly receivedAt:number; readonly expiresAt:number;
 readonly sourceSequence:string|null;readonly sourceHeight:string|null;readonly evidence:'unverified-provider-observation';
 readonly networkIdentityVerified:false;readonly executable:false;
}
export type Selection={provider:'injective';endpoint:string;network:string;marketId:string}|{provider:'hypercore';endpoint:string;network:string;pairIndex:number|string};
export interface ObservationOptions {
 access?:{mode?:'local-only'|'explicit-remote';allowedOrigins?:string[]};
 signal?:AbortSignal;fetchImpl?:typeof fetch;now?:()=>number;timeoutMs?:number;maxAgeMs?:number;
}
export interface Estimate {
 readonly schema:'realdex.external-spot-estimate.v1';readonly provider:Provider;readonly network:string;readonly marketId:string;
 readonly side:'sell-base'|'buy-base';readonly inputAsset:Asset;readonly outputAsset:Asset;readonly balanceLocation:string;
 readonly inputAtomic:Atomic;readonly consumedInputAtomic:Atomic;readonly remainingInputAtomic:Atomic;
 readonly estimatedOutputAfterTradingFeeAtomic:Atomic|null;readonly tradingFeeQuoteAtomic:Atomic|null;
 readonly hypotheticalSlippageFloorAtomic:Atomic|null;readonly baseFilledAtomic:Atomic;readonly quoteNotionalAtomic:Atomic;
 readonly outputBeforeTradingFeeAtomic:Atomic;readonly fillStatus:string;readonly fullInputConsumed:boolean;
 readonly minimumOrderKnown:boolean;readonly tradingFeesKnown:boolean;readonly additionalCostsKnown:false;readonly receivedAt:number;readonly expiresAt:number;
 readonly executable:false;readonly fillGuaranteed:false;readonly globallyOptimal:false;readonly deliveredToWallet:false;
}
