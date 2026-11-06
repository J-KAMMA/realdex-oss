/** Owner-only native Cosmos authorization; no arbitrary protobuf signing API. */
export type Atomic = string;
export type CosmosAuthzRequest = {requestKey:string;feeAtomic:Atomic;gasLimit:Atomic;memo?:string} & (
 | {action:'grant';grantee:string;recipient:string;limitAtomic:Atomic;expirationSeconds:string}
 | {action:'revoke';grantee:string}
 | {action:'execute';granter:string;recipient:string;amountAtomic:Atomic}
);
export interface AuthzPrepareRequest {accountId:string;networkId:string;payment:CosmosAuthzRequest}
export interface AuthzApproveRequest {id:string;intentId:string;confirmation:string;broadcast:boolean}
export type RestrictedGrant = {kind:'restricted-send';fingerprint:string;denom:string;remainingAtomic:Atomic;recipient:string;expirationSeconds:string};
export type ObservedGrant = RestrictedGrant | {kind:'unsupported';fingerprint:string} | null;
export interface AuthzStatus {networkId:string;granter:string;grantee:string;grant:ObservedGrant;finalityProven:false;observationOnly:true;feePayer:'transaction-signer';enforcedByChain:string[];notEnforced:string[]}
export interface AuthzRecordSummary {family:'cosmos';operation:`cosmos-authz-${'grant'|'revoke'|'execute'}-online`;granter:string;grantee:string;recipient:string;amountAtomic:Atomic;limitAtomic:Atomic|null;feePayer:string;confirmationText:string;submissionEnabled:boolean;finalityProven:false}
/** The API accepts an owner capability, never an AI/dapp session. Reconciliation never resends. */
export interface CosmosAuthzOwnerApi {
 prepare(request:AuthzPrepareRequest):Promise<{id:string;intentId:string;summary:AuthzRecordSummary}|{alreadyRecorded:true;submittedAgain:false}>;
 approve(request:AuthzApproveRequest):Promise<unknown>;
 status(request:{networkId:string;granter:string;grantee:string}):Promise<AuthzStatus>;
 submit(request:{id:string;confirmation:string}):Promise<unknown>;
 reconcile(request:{id:string}):Promise<unknown>;
}
