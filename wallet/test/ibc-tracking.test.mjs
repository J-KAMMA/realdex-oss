import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../lib/keys.mjs';
import {clone} from '../lib/guard.mjs';
import {packetSearchParams,normalizeSearchPage,discoverIbcEvidence} from '../bridge/ibc-discovery.mjs';
import {IbcRpc} from '../bridge/ibc-network.mjs';
import {IbcMonitor,monitorOptions} from '../bridge/ibc-monitor.mjs';
import {IbcEngine} from '../bridge/ibc-engine.mjs';
import {trackingVector} from './ibc-tracking-fixture.mjs';
const {packet,route}=trackingVector();
const range={minHeight:1,maxHeight:100,page:1};
function tx(i=1,code='0'){const raw=Buffer.from('untrusted index hint '+i);return {hash:sha256(raw).toString('hex').toUpperCase(),tx:raw.toString('base64'),height:String(i),index:'0',tx_result:{code}};}
const result=(txs=[])=>({txs,total_count:String(txs.length)});
function discoveryFixture(overrides={}) {
 const v=trackingVector(),calls=[],head={height:100,hash:'AA'.repeat(32)};
 const rpc={agree:async(n,fn,project=x=>x)=>{const vs=await Promise.all(n.endpoints.map((_,i)=>fn(i)));const ps=vs.map(project);assert.deepEqual(ps[0],ps[1]);return ps[0];},searchPackets:async(n,i,p,kind,range)=>{calls.push({n,i,kind,range});return result(kind==='receive'?[tx(1)]:kind==='acknowledge'?[tx(2)]:[]);}};
 const adapter={rpc,head:async()=>({...head}),block:async()=>({...head}),...overrides};
 return {...v,calls,adapter,source:{packet:v.packet,head}};
}
const ids=['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
function scheduler(probe=async()=>({state:'broadcast',report:{stage:'awaiting-receive'}})) {
 let time=1000,available=true,busy=false;const timers=[];
 const m=new IbcMonitor({probe,now:()=>time,available:()=>available,busy:()=>busy,setTimer:(fn,delay)=>{const t={fn,delay};timers.push(t);return t;},clearTimer:()=>{}});
 return {m,timers,setTime:t=>time=t,setAvailable:v=>available=v,setBusy:v=>busy=v};
}

test('packet searches bind both ports, both channels, sequence, fixed heights and ascending bounded page',()=>{
 const p=packetSearchParams(packet,'receive',range);assert.match(p.query,/recv_packet.packet_src_port = 'transfer'/);assert.match(p.query,/packet_dst_channel = 'channel-1'/);assert.match(p.query,/packet_sequence = '1'/);assert.match(p.query,/tx.height >= 1 AND tx.height <= 100$/);assert.equal(p.prove,true);assert.equal(p.per_page,'20');assert.equal(p.order_by,'asc');
});
for(const [name,mutate] of [
 ['injected channel',p=>p.source_channel="channel-0' OR tx.height > 0"],['wrong port',p=>p.destination_port='other'],
 ['zero sequence',p=>p.sequence='0'],['padded sequence',p=>p.sequence='01'],['overflow sequence',p=>p.sequence='18446744073709551616']
])test('packet query rejects '+name,()=>{const p=clone(packet);mutate(p);assert.throws(()=>packetSearchParams(p,'receive',range));});
test('search denies arbitrary event kind, reversed range, oversized page',()=>{assert.throws(()=>packetSearchParams(packet,'send',range));assert.throws(()=>packetSearchParams(packet,'receive',{...range,minHeight:101}));assert.throws(()=>packetSearchParams(packet,'receive',{...range,page:5}));});
test('empty event index is not settlement evidence',()=>{assert.deepEqual(normalizeSearchPage({txs:null,total_count:'0'},range),{total:0,candidates:[]});});
for(const [name,mutate] of [
 ['missing code',v=>delete v.txs[0].tx_result.code],['wrong hash',v=>v.txs[0].hash='DD'.repeat(32)],
 ['out of snapshot',v=>v.txs[0].height='101'],['truncated page',v=>v.total_count='2'],['over capacity',v=>v.total_count='81'],
 ['fractional count',v=>v.total_count='1.1'],['bad base64',v=>v.txs[0].tx='not-base64'],['duplicate transaction',v=>{v.txs.push(v.txs[0]);v.total_count='2';}]
])test('event index rejects '+name,()=>{const r=result([tx()]);mutate(r);assert.throws(()=>normalizeSearchPage(r,range));});
test('index ordering is checked, including equal-height transaction indexes',()=>{assert.throws(()=>normalizeSearchPage(result([tx(2),tx(1)]),range),/ORDER/);const r=result([tx(1),{...tx(2),height:'1',index:'1'}]);assert.equal(normalizeSearchPage(r,range).candidates.length,2);});
test('failed execution results are not chosen as receipt candidates',async()=>{const f=discoveryFixture();f.adapter.rpc.searchPackets=async()=>result([tx(1,'7')]);assert.deepEqual(await discoverIbcEvidence(f.adapter,f.route,f.record,f.source),{});});
test('discovery returns only two hashes, never accepts search events as evidence',async()=>{const f=discoveryFixture(),refs=await discoverIbcEvidence(f.adapter,f.route,f.record,f.source);assert.deepEqual(refs,{destinationTxHash:tx(1).hash,settlementTxHash:tx(2).hash});assert.equal(f.calls.length,6);assert.equal(f.calls[0].range.maxHeight,100);});
test('conflicting acknowledge and timeout candidates stop discovery',async()=>{const f=discoveryFixture();f.adapter.rpc.searchPackets=async(n,i,p,k)=>result([tx(k==='receive'?1:k==='timeout'?3:2)]);await assert.rejects(discoverIbcEvidence(f.adapter,f.route,f.record,f.source),/SETTLEMENT_CONFLICT/);});
test('multiple successful candidates are ambiguous, not first-match-wins',async()=>{const f=discoveryFixture();f.adapter.rpc.searchPackets=async()=>result([tx(1),tx(2)]);await assert.rejects(discoverIbcEvidence(f.adapter,f.route,f.record,f.source),/AMBIGUOUS/);});
test('discovery cannot silently replace previously recorded evidence hashes',async()=>{const f=discoveryFixture();f.record.report={evidenceRefs:{destinationTxHash:'BB'.repeat(32)}};await assert.rejects(discoverIbcEvidence(f.adapter,f.route,f.record,f.source),/REFERENCE_CONFLICT/);});
test('already recorded evidence survives index omission but must still be revalidated by engine',async()=>{const f=discoveryFixture();f.adapter.rpc.searchPackets=async()=>result();f.record.report={evidenceRefs:{destinationTxHash:tx(1).hash}};assert.deepEqual(await discoverIbcEvidence(f.adapter,f.route,f.record,f.source),f.record.report.evidenceRefs);});
test('snapshot change after searching prevents evidence selection',async()=>{const f=discoveryFixture({block:async()=>({hash:'FF'.repeat(32)})});await assert.rejects(discoverIbcEvidence(f.adapter,f.route,f.record,f.source),/SNAPSHOT_CHANGED/);});
test('stop authorization is rechecked between network awaits',async()=>{const f=discoveryFixture();let n=0;await assert.rejects(discoverIbcEvidence(f.adapter,f.route,f.record,f.source,{authorize:()=>{if(++n>2)throw Error('STOPPED');}}),/STOPPED/);assert.equal(f.calls.length,0);});
test('pagination covers bounded failed attempts before a successful result',async()=>{const f=discoveryFixture();f.adapter.rpc.searchPackets=async(n,i,p,k,q)=> k==='receive'?{txs:Array.from({length:q.page===1?20:1},(_,j)=>tx((q.page-1)*20+j+1,q.page===1?'7':'0')),total_count:'21'}:result();const r=await discoverIbcEvidence(f.adapter,f.route,f.record,f.source);assert.equal(r.destinationTxHash,tx(21).hash);});
test('pagination rejects a total changing between pages',async()=>{const f=discoveryFixture();f.adapter.rpc.searchPackets=async(n,i,p,k,q)=>({txs:q.page===1?Array.from({length:20},(_,j)=>tx(j+1,'7')):[],total_count:q.page===1?'21':'20'});await assert.rejects(discoverIbcEvidence(f.adapter,f.route,f.record,f.source),/SNAPSHOT_CHANGED/);});
test('RPC exposes fixed tx_search only through the constrained packet interface',async()=>{let body;const rpc=new IbcRpc({fetchImpl:async(url,o)=>{body=JSON.parse(o.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:result()}),{headers:{'content-type':'application/json'}});}});await rpc.searchPackets(route.source.network,0,packet,'receive',range);assert.equal(body.method,'tx_search');await assert.rejects(rpc.comet(route.source.network,0,'tx_search',{}),/FORBIDDEN/);});
test('disabled index returns an explicit unavailable error',async()=>{const rpc=new IbcRpc({fetchImpl:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{message:'index disabled'}}),{headers:{'content-type':'application/json'}})});await assert.rejects(rpc.searchPackets(route.source.network,0,packet,'receive',range),/INDEX_UNAVAILABLE/);});

test('monitor starts off and accepts only bounded targets and intervals',()=>{const f=scheduler();assert.equal(f.m.status().enabled,false);assert.throws(()=>monitorOptions({ids:[]}));assert.throws(()=>monitorOptions({ids:[ids[0],ids[0]]}));assert.throws(()=>monitorOptions({ids,intervalMs:1}));assert.throws(()=>monitorOptions({ids,sign:true}));});
test('monitor cycles fairly through targets without overlapping work',async()=>{const called=[],f=scheduler(async id=>{called.push(id);return {state:'broadcast'};});f.m.start({ids,intervalMs:5000});await f.m.tick();await f.m.tick();assert.deepEqual(called,ids);await f.m.tick();assert.equal(called.length,2);f.setTime(6000);await f.m.tick();assert.equal(called.length,3);f.m.stop();});
test('monitor continues rechecking terminal states rather than freezing success',async()=>{let checks=0;const f=scheduler(async()=>({report:{stage:++checks===1?'reported-delivered':'inconsistent',reason:'LOST_RECEIPT'}}));f.m.start({ids:[ids[0]],intervalMs:5000});await f.m.tick();f.setTime(6000);await f.m.tick();assert.equal(f.m.status().entries[0].stage,'inconsistent');f.m.stop();});
test('monitor backs off failures and resets after successful reads',async()=>{let fail=true;const f=scheduler(async()=>{if(fail)throw Error('COSMOS_RPC_DISAGREEMENT');return {state:'broadcast'};});f.m.start({ids:[ids[0]],intervalMs:5000});await f.m.tick();assert.equal(f.m.entries[0].nextAt,11000);fail=false;f.setTime(11000);await f.m.tick();assert.equal(f.m.entries[0].nextAt,16000);assert.equal(f.m.entries[0].failures,0);f.m.stop();});
test('monitor yields to owner requests',async()=>{let reads=0;const f=scheduler(async()=>{reads++;return {};});f.setBusy(true);f.m.start({ids});await f.m.tick();assert.equal(reads,0);f.setBusy(false);await f.m.tick();assert.equal(reads,1);f.m.stop();});
test('lock stops monitoring and unlocking does not resume it',async()=>{let reads=0;const f=scheduler(async()=>{reads++;return {};});f.m.start({ids});f.setAvailable(false);await f.m.tick();assert.equal(f.m.status().enabled,false);assert.equal(f.m.status().entries.length,0);f.setAvailable(true);await f.m.tick();assert.equal(reads,0);});
test('stop invalidates in-flight authorization and rejects overlapping restart',async()=>{let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let authorized=false;const f=scheduler(async(id,{authorize})=>{entered();await gate;authorize();authorized=true;return {};});f.m.start({ids});const p=f.m.tick();await ready;await f.m.tick();f.m.stop();assert.throws(()=>f.m.start({ids}),/DRAINING/);release();await p;assert.equal(authorized,false);assert.equal(f.m.status().entries.length,0);});
test('backward clock movement disables automatic observation',async()=>{const f=scheduler();f.m.start({ids});f.setTime(999);await f.m.tick();assert.equal(f.m.status().reason,'CLOCK_MOVED_BACKWARD');});
test('a new monitor never inherits enabled state or tokens',()=>{const a=scheduler();a.m.start({ids});const b=scheduler();assert.equal(b.m.status().enabled,false);assert.equal(b.m.status().signingAuthority,false);assert.equal(b.m.status().relayTransactions,false);a.m.stop();});

test('reconcile stop authorization is passed into the atomic vault update',async()=>{
 const f=trackingVector(),engine=new IbcEngine({now:()=>f.now});const record={...f.record,state:'broadcast'};let guard;
 engine.current=async()=>record;engine.adapter.source=async()=>{throw Error('COSMOS_RPC_HTTP_ERROR');};
 const vault={epoch:1,check(){},observeNonEvm:async(r,s,p,options)=>{guard=options.authorize;guard();return {...r,state:s,report:p};}};
 const result=await engine.reconcile(vault,f.route,record);assert.equal(result.report.stage,'inconsistent');assert.equal(typeof guard,'function');vault.epoch++;assert.throws(guard,/LOCK_INTERRUPTED/);
});

test('a bad discovered hint is not persisted as a trusted reference that poisons future discovery',async()=>{
 const f=discoveryFixture(),engine=new IbcEngine({now:()=>f.now});const record={...f.record,state:'broadcast'};
 engine.current=async()=>record;engine.adapter={...f.adapter,source:async()=>({...f.source,evidence:{executionCode:'0'}}),destination:async()=>{throw Error('IBC_RECEIVE_PACKET_MISMATCH');}};
 const vault={epoch:1,check(){},observeNonEvm:async(r,state,report)=>({...r,state,report})};
 const r=await engine.reconcile(vault,f.route,record,{},{discover:true});
 assert.equal(r.report.stage,'inconsistent');assert.deepEqual(r.report.evidenceRefs,{});
});


test('monitor environment failures stop without an unhandled timer rejection',async()=>{
 const f=scheduler();f.m.start({ids});f.m.available=()=>{throw Error('secret path must not leak');};await f.m.tick();assert.equal(f.m.status().enabled,false);assert.equal(f.m.status().reason,'WALLET_UNAVAILABLE');
});
test('monitor busy-probe failures stop explicitly',async()=>{
 const f=scheduler();f.m.start({ids});f.m.busy=()=>{throw Error('sensitive detail');};await f.m.tick();assert.equal(f.m.status().reason,'MONITOR_ENVIRONMENT_ERROR');
});
