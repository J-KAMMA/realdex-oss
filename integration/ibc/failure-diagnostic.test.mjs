import test from 'node:test';import assert from 'node:assert/strict';
import {boundedIbcFailureDiagnostic,diagnosticTapLine,runWithIbcFailureDiagnostic} from './failure-diagnostic.mjs';
const hex='a'.repeat(64);
function entry(sequence=1){return {sequence,peer:1,type:'rest',method:'GET',route:'channel',requestHeight:'358',responseHeight:null,gatewayResponseHeight:null,status:500,transportFailure:false,responseBytes:123,responseSha256:hex,nodeCode:2,nodeCondition:'unclassified',proofHeight:null,gasUsed:null,gasWanted:null,simulationRequestSha256:null,simulationResultSha256:null,stateDigests:{channel:hex,evil:'SECRET'},requestBody:'DO_NOT_LOG',responseBody:'DO_NOT_LOG',authorization:'DO_NOT_LOG'};}
function endpoint(){return {schema:'realdex.ibc-http-diagnostics.v1',capacity:64,total:576,failures:3,discarded:512,lastFailure:entry(576),recent:Array.from({length:20},(_,i)=>entry(557+i)),rawPayloadsIncluded:false,secret:'DO_NOT_LOG'};}
test('bounded relay diagnostic keeps useful route/height/status fingerprints and drops raw data',()=>{
 const report={schema:'realdex.ibc-fixture-diagnostics.v1',failures:[{code:'COSMOS_RPC_HTTP_ERROR',raw:'DO_NOT_LOG'}],a:endpoint(),b:endpoint(),secret:'DO_NOT_LOG'};
 const value=boundedIbcFailureDiagnostic(Error('COSMOS_RPC_HTTP_ERROR'),report),json=JSON.stringify(value);
 assert.equal(value.code,'COSMOS_RPC_HTTP_ERROR');assert.deepEqual(value.recordedCodes,['COSMOS_RPC_HTTP_ERROR']);assert.equal(value.a.recent.length,8);assert.equal(value.a.lastFailure.requestHeight,'358');assert.equal(value.a.lastFailure.status,500);assert.equal(value.a.lastFailure.stateDigests.channel,hex);
 for(const secret of ['DO_NOT_LOG','requestBody','responseBody','authorization'])assert.equal(json.includes(secret),false,secret);
 assert.equal(value.rawPayloadsIncluded,false);assert.ok(Buffer.byteLength(json)<65536);
});
test('arbitrary exception text and stacks are never emitted',()=>{
 const error=Error('https://secret.invalid/?token=abc');error.stack='PRIVATE_STACK';const line=diagnosticTapLine(error,{a:endpoint(),b:endpoint(),failures:[]});
 assert.match(line,/^# relay fixture diagnostic /);assert.match(line,/IBC_RELAY_TEST_FAILURE/);assert.equal(line.includes('secret.invalid'),false);assert.equal(line.includes('PRIVATE_STACK'),false);
});
test('oversized or attacker-owned report fields cannot expand the diagnostic',()=>{
 const e=endpoint();e.recent=Array.from({length:10000},(_,i)=>({...entry(i),junk:'x'.repeat(10000)}));
 const value=boundedIbcFailureDiagnostic(Error('COSMOS_RPC_DISAGREEMENT'),{a:e,b:e,failures:Array.from({length:1000},()=>({code:'COSMOS_RPC_DISAGREEMENT',junk:'x'.repeat(10000)}))});
 assert.equal(value.a.recent.length,8);assert.equal(value.recordedCodes.length,4);assert.ok(Buffer.byteLength(JSON.stringify(value))<65536);
});

test('failure wrapper writes one bounded diagnostic and rethrows the original error',async()=>{
 const original=Error('COSMOS_RPC_HTTP_ERROR'),lines=[];let reports=0;
 await assert.rejects(runWithIbcFailureDiagnostic(async()=>{throw original;},()=>{reports++;return {a:endpoint(),b:endpoint(),failures:[{code:'COSMOS_RPC_HTTP_ERROR'}]};},line=>lines.push(line)),error=>error===original);
 assert.equal(reports,1);assert.equal(lines.length,1);assert.match(lines[0],/COSMOS_RPC_HTTP_ERROR/);assert.equal(lines[0].includes('DO_NOT_LOG'),false);
});

test('oversized allowlisted strings are dropped instead of expanding or leaking the report',()=>{
 const e=endpoint();e.lastFailure.route='s'.repeat(100000);e.lastFailure.requestHeight='7'.repeat(100000);e.recent=[e.lastFailure];
 const value=boundedIbcFailureDiagnostic(Error('COSMOS_RPC_HTTP_ERROR'),{a:e,b:e,failures:[]});
 assert.equal(value.a.lastFailure.route,null);assert.equal(value.a.lastFailure.requestHeight,null);assert.ok(Buffer.byteLength(JSON.stringify(value))<65536);
});
test('diagnostic callback or output failure never replaces the original operation error',async()=>{
 for(const mode of ['report','write']){
  const original=Error('COSMOS_RPC_HTTP_ERROR');
  await assert.rejects(runWithIbcFailureDiagnostic(async()=>{throw original;},()=>{if(mode==='report')throw Error('REPORT_BROKEN');return {a:endpoint(),b:endpoint(),failures:[]};},()=>{if(mode==='write')throw Error('WRITE_BROKEN');}),error=>error===original);
 }
});
