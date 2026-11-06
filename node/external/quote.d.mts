import type {Snapshot,Estimate,Atomic} from './index.d.mts';
export function quoteSpot(snapshot:Snapshot,request:{side:'sell-base'|'buy-base';inputAtomic:Atomic;limitPrice?:string;slippageBps?:number},options?:{now?:number}):Estimate;
export function compareIndicativeQuotes(quotes:Estimate[],options?:{now?:number}):{schema:string;basis:string;ranking:{index:number;output:Atomic}[];rejected:{index:number;reasons:string[]}[];netBest:null;executable:false;globallyOptimal:false};
