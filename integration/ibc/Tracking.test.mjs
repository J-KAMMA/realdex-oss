/** Real two-chain observer tests. Relaying stays a separate test actor, never the monitor. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {ibcWalletFixture} from './wallet-fixture.mjs';
import {receivePacket,acknowledgePacket,timeoutPacket,until} from './devnet.mjs';
import {PASSWORD,storeFixture} from '../../wallet/test/fixtures.mjs';
import {Vault} from '../../wallet/lib/vault.mjs';
import {WalletServer} from '../../wallet/lib/server.mjs';
let f,delivered;
before(async()=>{f=await ibcWalletFixture(process.env.REALDEX_IBC_LOG_DIRECTORY?process.env.REALDEX_IBC_LOG_DIRECTORY+'/tracking':undefined);});
after(async()=>{await f?.close();});
async function send(index,key,extra={}) {
 const p=await f.call('ibc/prepare',{routeId:f.route.id,accountId:f.accounts[index].id,payment:f.payment(f.accounts[1].address,{requestKey:key,...extra})});
 return (await f.call('ibc/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.confirmationText,broadcast:true})).record;
}
const track=r=>f.call('ibc/track',{id:r.id});
const source=r=>until(async()=>{const x=await track(r);return x.report.packet?x:false;});
async function relay(r) {
 const d=await receivePacket(f.a,f.b,f.lane.bClient,r.report.packet);
 const a=await acknowledgePacket(f.a,f.b,f.lane.aClient,r.report.packet,d.acknowledgement);
 return {destinationTxHash:d.result.hash,settlementTxHash:a.hash};
}
test('auto discovery follows receive then acknowledgement without any caller-supplied hash',async()=>{
 const r=await source(await send(0,'auto-tracking-out'));assert.equal(r.report.stage,'awaiting-receive',r.report.reason);
 const d=await receivePacket(f.a,f.b,f.lane.bClient,r.report.packet),middle=await track(r);
 assert.equal(middle.report.stage,'awaiting-ack',middle.report.reason);assert.equal(middle.report.completed,false);assert.equal(middle.report.evidenceRefs.destinationTxHash,d.result.hash);
 const ack=await acknowledgePacket(f.a,f.b,f.lane.aClient,r.report.packet,d.acknowledgement);
 delivered=await until(async()=>{const x=await track(r);return x.report.completed?x:false;});
 assert.equal(delivered.report.stage,'reported-delivered');assert.equal(delivered.report.evidenceRefs.settlementTxHash,ack.hash);assert.equal(delivered.report.finalityProven,false);
});
test('repeated automatic tracking never signs, simulates or sends',async()=>{
 const records=(await f.vault.nonEvmRecords()).length,count=f.pa.submissions,startA=f.pa.requests.length,startB=f.pb.requests.length;
 await track(delivered);await track(delivered);
 assert.equal((await f.vault.nonEvmRecords()).length,records);assert.equal(f.pa.submissions,count);
 for(const req of [...f.pa.requests.slice(startA),...f.pb.requests.slice(startB)]){
  if(req.type==='rpc')assert.ok(['status','block','tx','tx_search'].includes(JSON.parse(req.body).method));
  else assert.ok(!req.path.includes('/simulate')&&!req.path.endsWith('/txs'));
 }
});
test('observer finds processed timeout refund, never declares a refund from elapsed time',async()=>{
 const before=await f.a.balance(f.accounts[2].address),r=await source(await send(2,'tracking-timeout',{timeoutSeconds:30}));
 await until(async()=>{const h=await f.b.head(),b=await f.b.rpc('block',{height:String(h)});return BigInt(Date.parse(b.block.header.time))*1000000n>BigInt(r.report.packet.timeout_timestamp);},40000);
 const elapsed=await track(r);assert.equal(elapsed.report.stage,'awaiting-refund');assert.equal(elapsed.report.refunded,false);
 const timeout=await timeoutPacket(f.a,f.b,f.lane.aClient,r.report.packet),done=await track(r);
 assert.equal(done.report.refunded,true,done.report.reason);assert.equal(done.report.evidenceRefs.settlementTxHash,timeout.hash);assert.equal(await f.a.balance(f.accounts[2].address),before-50000n);
});
test('error acknowledgement is discovered and refunded only after source processing',async()=>{
 const modules=(await f.b.state('cosmos/auth/v1beta1/module_accounts')).accounts;
 const blocked=modules.find(a=>a.name==='distribution').base_account.address;
 const r=await source(await send(3,'tracking-error',{receiver:blocked}));
 const d=await receivePacket(f.a,f.b,f.lane.bClient,r.report.packet),mid=await track(r);
 assert.equal(mid.report.stage,'awaiting-refund',mid.report.reason);assert.equal(mid.report.refunded,false);
 await acknowledgePacket(f.a,f.b,f.lane.aClient,r.report.packet,d.acknowledgement);
 assert.equal((await track(r)).report.refunded,true);
});
test('disagreeing indexes withdraw successful observation; manual recorded-hash reconciliation still works',async()=>{
 f.pb.mutate=({peer,type,text})=>{if(peer===1&&type==='rpc'){const j=JSON.parse(text);if(j.result&&Object.hasOwn(j.result,'total_count'))return JSON.stringify({...j,result:{txs:[],total_count:'0'}});}return text;};
 try{const r=await track(delivered);assert.equal(r.report.completed,false);assert.equal(r.report.received,false);assert.equal(r.report.reason,'COSMOS_RPC_DISAGREEMENT');}
 finally{f.pb.mutate=null;}
 const fixed=await f.call('ibc/reconcile',{id:delivered.id});assert.equal(fixed.report.received,true,fixed.report.reason);
});
test('disabled tx index is explicit and manual evidence remains available',async()=>{
 f.pb.mutate=({type,text})=>{if(type==='rpc'){const j=JSON.parse(text);if(j.result&&Object.hasOwn(j.result,'total_count'))return JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32603,message:'index disabled'}});}return text;};
 try{const r=await track(delivered);assert.equal(r.report.received,false);assert.equal(r.report.reason,'IBC_INDEX_UNAVAILABLE');const manual=await f.call('ibc/reconcile',{id:delivered.id});assert.equal(manual.report.received,true,manual.report.reason);}
 finally{f.pb.mutate=null;}
});
test('session monitor persists discoveries without extending the vault inactivity deadline',async()=>{
 const expires=f.vault.expiresAt,before=f.pa.submissions;
 const status=await f.call('ibc/monitor/start',{ids:[delivered.id],intervalMs:5000});assert.equal(status.enabled,true);
 await until(async()=>{const s=await f.call('ibc/monitor/status');return s.entries[0]?.checks>0?s:false;});
 assert.equal(f.vault.expiresAt,expires);assert.equal(f.pa.submissions,before);assert.equal((await f.call('ibc/history')).records.find(r=>r.id===delivered.id).report.received,true);
 await f.call('ibc/monitor/stop');assert.equal((await f.call('ibc/monitor/status')).enabled,false);
});
test('owner stop bypasses request rate limit and cancels in-flight persistence',async()=>{
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let held=false;
 const before=(await f.vault.nonEvmRecords()).find(r=>r.id===delivered.id);
 f.pb.hook=async({type,body})=>{if(type==='rpc'&&JSON.parse(body).method==='tx_search'){if(!held){held=true;entered();}await gate;}};
 await f.call('ibc/monitor/start',{ids:[delivered.id],intervalMs:5000});
 try{await ready;f.app.budget={at:Date.now(),n:600};assert.equal((await f.call('ibc/monitor/stop')).enabled,false);release();await until(()=>!f.app.ibc.monitor.running);
  const after=(await f.vault.nonEvmRecords()).find(r=>r.id===delivered.id);assert.deepEqual(after,before);}
 finally{release();f.pb.hook=null;f.app.budget={at:0,n:0};}
});
test('wallet lock stops polling; unlock requires explicit monitoring restart',async()=>{
 await f.call('ibc/monitor/start',{ids:[delivered.id],intervalMs:5000});await f.call('lock');
 assert.equal((await f.call('ibc/monitor/status')).enabled,false);await f.vault.unlock(PASSWORD);
 assert.equal((await f.call('ibc/monitor/status')).enabled,false);assert.equal(f.app.ibc.monitor.entries.length,0);
});
test('new API rejects unauthenticated observation and extra payload fields',async()=>{
 const r=await fetch(f.started.origin+'/api/ibc/track',{method:'POST',headers:{origin:f.started.origin,'content-type':'application/json'},body:JSON.stringify({id:delivered.id})});assert.equal(r.status,401);
 await assert.rejects(f.call('ibc/track',{id:delivered.id,broadcast:true}),/SCHEMA/);
 await assert.rejects(f.call('ibc/monitor/start',{ids:[delivered.id],intervalMs:1}),/INTERVAL/);
});
test('persisted bridge references survive encrypted backup; monitor permissions do not',async()=>{
 await until(()=>!f.app.ibc.monitor.running);const backup=await f.vault.backup(),tmp=storeFixture();
 try{const vault=new Vault(tmp.store);await vault.restore(backup.encrypted,PASSWORD);await vault.unlock(PASSWORD);
  const r=(await vault.nonEvmRecords()).find(r=>r.id===delivered.id);assert.deepEqual(r.report.evidenceRefs,delivered.report.evidenceRefs);
  const server=new WalletServer({store:tmp.store,vault,settings:f.app.settings});assert.equal(server.ibc.monitor.status().enabled,false);vault.lock();}
 finally{tmp.close();}
});
