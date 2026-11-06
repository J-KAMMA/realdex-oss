import type {CosmosAuthzOwnerApi, CosmosAuthzRequest, AuthzPrepareRequest} from '../../non-evm/cosmos-authz-api.js';
export const grant: CosmosAuthzRequest = {action:'grant',requestKey:'grant-1',feeAtomic:'800',gasLimit:'400000',grantee:'cosmos1...',recipient:'cosmos1...',limitAtomic:'3000000',expirationSeconds:'1788739200'};
export const execute: CosmosAuthzRequest = {action:'execute',requestKey:'send-1',feeAtomic:'800',gasLimit:'400000',granter:'cosmos1...',recipient:'cosmos1...',amountAtomic:'1000000'};
export const revoke: CosmosAuthzRequest = {action:'revoke',requestKey:'revoke-1',feeAtomic:'800',gasLimit:'400000',grantee:'cosmos1...'};
// @ts-expect-error Generic protobuf messages are intentionally not an API field.
const arbitrary:CosmosAuthzRequest = {action:'execute',requestKey:'bad',feeAtomic:'1',gasLimit:'2',granter:'a',recipient:'b',amountAtomic:'1',messages:[]};
void arbitrary;
// @ts-expect-error New grants require an explicit expiry.
const forever:CosmosAuthzRequest = {action:'grant',requestKey:'bad',feeAtomic:'1',gasLimit:'2',grantee:'a',recipient:'b',limitAtomic:'1'};
void forever;
export async function stage(api:CosmosAuthzOwnerApi,request:AuthzPrepareRequest):Promise<string> {
 const prepared=await api.prepare(request);
 if('alreadyRecorded' in prepared)return 'already recorded; do not resubmit';
 return prepared.summary.confirmationText;
}
