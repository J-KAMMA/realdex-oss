/** Test-only bounded IBC failure diagnostics for TAP logs.
 * Copies only allowlisted fingerprints already produced by http-diagnostics.mjs.
 * Never includes raw request/response bodies, account data, credentials, or stacks.
 * Diagnostic generation is best-effort and must never replace the original failure.
 */
const ENTRY_KEYS=Object.freeze([
  'sequence','peer','type','method','route','requestHeight','responseHeight','gatewayResponseHeight',
  'status','transportFailure','responseBytes','responseSha256','nodeCode','nodeCondition','proofHeight',
  'gasUsed','gasWanted','simulationRequestSha256','simulationResultSha256','stateDigests'
]);
const SAFE_CODE=/^[A-Z][A-Z0-9_]{1,79}$/;
const MAX_TEXT=256;
function scalar(value){
  if(value===null||typeof value==='boolean'||typeof value==='number')return value;
  if(typeof value==='string'&&value.length<=MAX_TEXT)return value;
  return null;
}
function copyEntry(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const out={};for(const key of ENTRY_KEYS){
    if(!Object.hasOwn(value,key))continue;
    if(key==='stateDigests'){
      const src=value[key];const digests={};
      if(src&&typeof src==='object'&&!Array.isArray(src))for(const name of ['channel','connection','client_state','balance','gas_info']){
        const digest=src[name];if(typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest))digests[name]=digest;
      }
      out[key]=digests;continue;
    }
    out[key]=scalar(value[key]);
  }
  return out;
}
function copyEndpoint(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  return {
    schema:'realdex.ibc-http-diagnostics.v1',
    total:Number.isSafeInteger(value.total)&&value.total>=0?value.total:null,
    failures:Number.isSafeInteger(value.failures)&&value.failures>=0?value.failures:null,
    discarded:Number.isSafeInteger(value.discarded)&&value.discarded>=0?value.discarded:null,
    lastFailure:copyEntry(value.lastFailure),
    recent:Array.isArray(value.recent)?value.recent.slice(-8).map(copyEntry).filter(Boolean):[],
    rawPayloadsIncluded:false
  };
}
export function boundedIbcFailureDiagnostic(error,report){
  const message=error instanceof Error?error.message:String(error??'');
  const code=SAFE_CODE.test(message)?message:'IBC_RELAY_TEST_FAILURE';
  const codes=Array.isArray(report?.failures)?report.failures.slice(-4).map(x=>SAFE_CODE.test(x?.code??'')?x.code:'IBC_RELAY_TEST_FAILURE'):[];
  const value={schema:'realdex.ibc-relay-failure-diagnostic.v1',code,recordedCodes:codes,a:copyEndpoint(report?.a),b:copyEndpoint(report?.b),rawPayloadsIncluded:false};
  const json=JSON.stringify(value);
  if(Buffer.byteLength(json)>65536)throw Error('IBC_DIAGNOSTIC_SIZE_LIMIT');
  return value;
}
export function diagnosticTapLine(error,report){return '# relay fixture diagnostic '+JSON.stringify(boundedIbcFailureDiagnostic(error,report));}
export async function runWithIbcFailureDiagnostic(operation,report,write=message=>console.log(message)){
  if(typeof operation!=='function'||typeof report!=='function'||typeof write!=='function')throw Error('IBC_DIAGNOSTIC_CALLBACK_REQUIRED');
  try{return await operation();}
  catch(error){
    // Diagnostics are evidence only. A broken reporter, oversized observation, or
    // failed output sink must never hide or replace the actual operation error.
    try{write(diagnosticTapLine(error,report()));}catch{}
    throw error;
  }
}
