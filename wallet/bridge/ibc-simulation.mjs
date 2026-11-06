/** IBC simulation is an estimate, not committed application state or execution.
 * INJ12: actual pinned-node calls at one height can differ only in gas_used.
 * Require identical results/meters and EVERY estimate under the signed cap;
 * select the maximum (never average/minimum). No retries or broadcast methods.
 */
import {createHash} from 'node:crypto';
import {need,shape,uint,canonical,freeze} from '../lib/guard.mjs';
import {U64,cosmosInt} from '../non-evm/cosmos-network.mjs';
const digest=x=>createHash('sha256').update(canonical(x)).digest('hex');
function observation(value,limit){
 shape(value,['gas_info','result']);shape(value.gas_info,['gas_wanted','gas_used']);
 const gas=uint(value.gas_info.gas_used,U64),meter=uint(value.gas_info.gas_wanted,U64);
 need(gas>0n&&gas<=limit,'IBC_SIMULATION_GAS_LIMIT');
 need(meter>0n&&gas<=meter,'IBC_SIMULATION_METER_INVALID');
 // Full semantic result agreement, not just successful HTTP or the gas counter.
 shape(value.result,[],['data','log','events','msg_responses']);
 need(Array.isArray(value.result.events)&&value.result.events.length<=128,'IBC_SIMULATION_RESULT_INVALID');
 if(Object.hasOwn(value.result,'data'))need(typeof value.result.data==='string'&&value.result.data.length<=65536,'IBC_SIMULATION_RESULT_INVALID');
 if(Object.hasOwn(value.result,'log'))need(typeof value.result.log==='string'&&value.result.log.length<=65536,'IBC_SIMULATION_RESULT_INVALID');
 if(Object.hasOwn(value.result,'msg_responses'))need(Array.isArray(value.result.msg_responses)&&value.result.msg_responses.length<=32,'IBC_SIMULATION_RESULT_INVALID');
 const result=canonical(value.result);need(result.length<=262144,'IBC_SIMULATION_RESULT_LIMIT');
 return {gas,meter,result};
}
export function validateIbcSimulations(responses,gasLimit){
 const limit=uint(gasLimit,10000000n);need(limit>0n,'IBC_SIMULATION_GAS_LIMIT');
 need(Array.isArray(responses)&&responses.length>=2&&responses.length<=4,'IBC_SIMULATION_ENDPOINT_COUNT');
 const values=responses.map(v=>observation(v,limit)),first=values[0];
 need(values.every(v=>v.meter===first.meter&&v.result===first.result),'COSMOS_RPC_DISAGREEMENT');
 const gasUsed=values.reduce((max,v)=>v.gas>max?v.gas:max,0n);
 return freeze({schema:'realdex.ibc-simulation-estimate.v1',gasUsed:String(gasUsed),
  gasLimit:String(limit),gasWanted:String(first.meter),observedGasUsed:values.map(v=>String(v.gas)),
  estimatesDiffer:values.some(v=>v.gas!==first.gas),resultSha256:digest(responses[0].result),
  selection:'maximum-of-all-endpoints',executionConfirmed:false,stateProofVerified:false});
}
export async function simulateIbc(rpc,network,txBytes,height,gasLimit){
 need(Array.isArray(network?.endpoints)&&network.endpoints.length>=2&&network.endpoints.length<=4,'IBC_SIMULATION_ENDPOINT_COUNT');
 need(cosmosInt(height)>0,'IBC_QUERY_HEIGHT_REQUIRED');
 const limit=uint(gasLimit,10000000n);need(limit>0n,'IBC_SIMULATION_GAS_LIMIT');
 need(typeof txBytes==='string'&&txBytes.length>0&&txBytes.length<=21848&&Buffer.from(txBytes,'base64').toString('base64')===txBytes,'COSMOS_TX_BYTES_INVALID');
 // One read-only simulation per configured endpoint, exact same bytes and height.
 // A missing response, transport rejection, bad metadata or execution error fails.
 const responses=await Promise.all(network.endpoints.map((_,i)=>rpc.rest(network,i,
  'cosmos/tx/v1beta1/simulate',{height,body:{tx_bytes:txBytes}})));
 return validateIbcSimulations(responses,gasLimit);
}
