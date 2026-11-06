import type {UnsignedOrderPlan,InjectiveOrderObservation,InjectiveObservedProgress} from './injective-orders.mjs';
export const JOURNAL_LIMITS: Readonly<{entries:1024;bytes:2097152}>;
export interface InjectiveJournalReceipt {
 schema:'realdex.injective-journal-receipt.v1';journalSha256:string;planSha256:string;entryCount:number;
 state:InjectiveObservedProgress;duplicate:boolean;localConsistencyVerified:true;
 historyAuthenticated:false;settlementVerified:false;signingEnabled:false;broadcastEnabled:false;executable:false;
}
/** Linux local filesystems only. New dedicated directory; private existing parent required. */
export function createInjectiveObservationJournal(directory:string,plan:UnsignedOrderPlan,first:InjectiveOrderObservation):InjectiveJournalReceipt;
/** No writes, lock stealing, recovery, or history authentication. */
export function inspectInjectiveObservationJournal(directory:string,options?:{expectedHead?:string}):InjectiveJournalReceipt;
/** WRITE_UNCERTAIN requires manual recovery; do not retry assuming no write occurred. */
export function appendInjectiveObservation(directory:string,observation:InjectiveOrderObservation,options:{expectedHead:string}):InjectiveJournalReceipt;
