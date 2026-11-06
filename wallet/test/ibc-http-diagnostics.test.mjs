import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHttpDiagnostics} from '../../integration/ibc/http-diagnostics.mjs';
const base=()=>({type:'rest',peer:0,method:'GET',path:'/cosmos/auth/v1beta1/accounts/PRIVATE_ADDRESS?token=PRIVATE_TOKEN',requestHeight:'123',status:200,responseHeight:'123',responseBody:'{"account":"PRIVATE_ADDRESS"}'});
test('Diagnostic output contains only allowlisted metadata and response digest',()=>{
 const d=createHttpDiagnostics(),i=base();i.headers={authorization:'PRIVATE_AUTH'};d.record(i);const s=d.snapshot(),r=s.recent[0];
 assert.equal(r.route,'account');assert.equal(r.requestHeight,'123');assert.equal(r.status,200);
 assert.equal(r.responseSha256,createHash('sha256').update(i.responseBody).digest('hex'));
 const text=JSON.stringify(s);for(const secret of ['PRIVATE_ADDRESS','PRIVATE_TOKEN','PRIVATE_AUTH','token=','http://'])assert.equal(text.includes(secret),false);
 assert.equal(s.rawPayloadsIncluded,false);assert.equal(s.historicalRootCauseProven,false);assert.equal(s.retriesPerformedByRecorder,0);
});
test('Ring and independent last failure stay bounded after many successes',()=>{
 const d=createHttpDiagnostics({capacity:3});d.record({...base(),status:503});for(let i=0;i<1000;i++)d.record(base());const s=d.snapshot();
 assert.equal(s.total,1001);assert.equal(s.failures,1);assert.equal(s.recent.length,3);assert.equal(s.discarded,998);assert.equal(s.lastFailure.sequence,1);
});
test('Snapshot mutation cannot alter future evidence',()=>{
 const d=createHttpDiagnostics();d.record({...base(),status:500});const s=d.snapshot();s.recent[0].status=200;s.lastFailure.status=200;s.recent.push({});
 assert.equal(d.snapshot().recent.length,1);assert.equal(d.snapshot().lastFailure.status,500);
});
for(const capacity of [0,-1,129,1.5,'64',null])test('Invalid ring capacity '+JSON.stringify(capacity),()=>assert.throws(()=>createHttpDiagnostics({capacity}),/CAPACITY/));
for(const requestHeight of ['-1','01','1, 2','18446744073709551616','PRIVATE_HEADER',123])test('Malformed height values are not copied '+JSON.stringify(requestHeight),()=>{
 const d=createHttpDiagnostics();d.record({...base(),requestHeight});assert.equal(d.snapshot().recent[0].requestHeight,'invalid');
});
test('Uint64 boundary and alternate gateway header are preserved separately',()=>{
 const d=createHttpDiagnostics();d.record({...base(),requestHeight:'18446744073709551615',responseHeight:null,gatewayResponseHeight:'123'});const r=d.snapshot().recent[0];
 assert.equal(r.requestHeight,'18446744073709551615');assert.equal(r.responseHeight,null);assert.equal(r.gatewayResponseHeight,'123');
});
test('No guessed node condition for unrelated error bodies',()=>{
 const d=createHttpDiagnostics();d.record({...base(),status:500,responseBody:JSON.stringify({code:13,message:'PRIVATE_PATH authentication rejected'})});const r=d.snapshot().recent[0];
 assert.equal(r.nodeCode,13);assert.equal(r.nodeCondition,'unclassified');assert.equal(JSON.stringify(d.snapshot()).includes('PRIVATE_PATH'),false);
});
test('Only a bounded named node report is classified, never its raw message',()=>{
 const d=createHttpDiagnostics();d.record({...base(),status:500,responseBody:'{"code":3,"message":"height 123 must be less than or equal to current height 122 PRIVATE_PATH"}'});
 assert.equal(d.snapshot().recent[0].nodeCondition,'height-unavailable-reported');assert.equal(JSON.stringify(d.snapshot()).includes('PRIVATE_PATH'),false);
});
test('Invalid or huge bodies do not crash, leak, or grow stored evidence',()=>{
 const d=createHttpDiagnostics();for(const responseBody of ['not json','[]','{"code":"13","message":"oops"}','x'.repeat(1048577)])d.record({...base(),status:500,responseBody});
 assert.equal(d.snapshot().recent.at(-1).responseSha256,null);assert.equal(d.snapshot().recent.at(-1).responseBytes,1048577);assert.ok(JSON.stringify(d.snapshot()).length<4000);
});
test('Transport failures record no exception or request body',()=>{
 const d=createHttpDiagnostics();d.record({...base(),status:undefined,responseBody:undefined,transportFailure:true,exception:Error('PRIVATE_SECRET')});
 const r=d.snapshot().lastFailure;assert.equal(r.status,null);assert.equal(r.responseSha256,null);assert.equal(r.transportFailure,true);assert.equal(JSON.stringify(d.snapshot()).includes('PRIVATE_SECRET'),false);
});
test('RPC method allowlist excludes arbitrary method and parameter strings',()=>{
 const d=createHttpDiagnostics();for(const method of ['abci_query','tx','PRIVATE_SECRET'])d.record({...base(),type:'rpc',requestBody:JSON.stringify({method,params:{secret:'PRIVATE_SECRET'}})});
 assert.deepEqual(d.snapshot().recent.map(x=>x.route),['abci_query','tx','other-rpc']);assert.equal(JSON.stringify(d.snapshot()).includes('PRIVATE_SECRET'),false);
});
test('Unknown REST URL is classified without copying path',()=>{
 const d=createHttpDiagnostics();d.record({...base(),path:'/private/PASSWORD'});assert.equal(d.snapshot().recent[0].route,'other-rest');assert.equal(JSON.stringify(d.snapshot()).includes('PASSWORD'),false);
});
test('Diagnostic calls never mutate their input or request counters',()=>{
 const i=base(),original=structuredClone(i),d=createHttpDiagnostics();d.record(i);assert.deepEqual(i,original);assert.equal(d.snapshot().total,1);
});
test('State fingerprints separate application data from response proof metadata',()=>{
 const d=createHttpDiagnostics(),value={channel:{state:'STATE_OPEN',privateKey:'PRIVATE'},proof_height:{revision_height:'100'}};
 d.record({...base(),responseBody:JSON.stringify(value)});value.proof_height.revision_height='101';d.record({...base(),responseBody:JSON.stringify(value)});
 const [a,b]=d.snapshot().recent;assert.equal(a.stateDigests.channel,b.stateDigests.channel);assert.notEqual(a.responseSha256,b.responseSha256);assert.notEqual(a.proofHeight,b.proofHeight);assert.equal(JSON.stringify(d.snapshot()).includes('PRIVATE'),false);
});

test('Gas-estimate diagnostics distinguish request/result identity from gas-use variance',()=>{
 const d=createHttpDiagnostics(),r={gas_info:{gas_wanted:'2000000',gas_used:'124637'},result:{events:[],data:'PUBLIC_TEST_DATA'}};
 const requestBody=JSON.stringify({tx_bytes:'PRIVATE_UNSIGNED_TX'}),input={...base(),path:'/cosmos/tx/v1beta1/simulate',method:'POST',requestBody};
 d.record({...input,responseBody:JSON.stringify(r)});r.gas_info.gas_used='124682';d.record({...input,peer:1,responseBody:JSON.stringify(r)});
 const [a,b]=d.snapshot().recent;
 assert.equal(a.simulationRequestSha256,b.simulationRequestSha256);assert.equal(a.simulationResultSha256,b.simulationResultSha256);
 assert.notEqual(a.gasUsed,b.gasUsed);assert.equal(a.gasWanted,'2000000');assert.notEqual(a.responseSha256,b.responseSha256);
 assert.ok(!JSON.stringify(d.snapshot()).includes('PRIVATE_UNSIGNED_TX'));assert.ok(!JSON.stringify(d.snapshot()).includes('PUBLIC_TEST_DATA'));
});
test('Non-simulation and oversized request payloads are not hashed as a simulation request',()=>{
 const d=createHttpDiagnostics();d.record({...base(),requestBody:'PRIVATE'});
 d.record({...base(),path:'/cosmos/tx/v1beta1/simulate',requestBody:'x'.repeat(65537)});
 assert.deepEqual(d.snapshot().recent.map(x=>x.simulationRequestSha256),[null,null]);
});
