import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {ibcWalletFixture} from './wallet-fixture.mjs';
import {assertStoreFailure} from './save-failure.mjs';
import {receivePacket,acknowledgePacket,timeoutPacket,until} from './devnet.mjs';
import {routeAssets} from '../../wallet/bridge/ibc-config.mjs';
import {Vault} from '../../wallet/lib/vault.mjs';
import {PASSWORD,storeFixture} from '../../wallet/test/fixtures.mjs';
let f,delivered,returned;
before(async()=>{f=await ibcWalletFixture(process.env.REALDEX_IBC_LOG_DIRECTORY);});
after(async(t)=>{try{if(f)t.diagnostic(JSON.stringify(f.diagnosticReport()));}finally{await f?.close();}});
const prepare=(index,key,extra={},reverse=false)=>f.call('ibc/prepare',{routeId:(reverse?f.reverse:f.route).id,accountId:f.accounts[index].id,payment:f.payment(f.accounts[reverse?0:1].address,{requestKey:key,...extra})});
const approve=async(p,broadcast=true)=>(await f.call('ibc/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.confirmationText,broadcast})).record;
async function rejectedByChain(fn,pattern){
 let result;
 try{result=await fn();}catch(e){assert.match(e.message,/^IBC_CHECKTX: /);const v=JSON.parse(e.message.slice('IBC_CHECKTX: '.length));assert.notEqual(v.code,0);assert.match(v.raw_log,pattern);return {hash:v.txhash,code:v.code,log:v.raw_log,stage:'CheckTx'};}
 const v=result.result??result;assert.notEqual(v.tx_result.code,0);assert.match(v.tx_result.log,pattern);return {hash:v.hash,code:v.tx_result.code,log:v.tx_result.log,stage:'execution'};
}
async function source(r){return until(async()=>{const x=await f.call('ibc/reconcile',{id:r.id});return x.report.packet?x:false;});}
async function finish(r,reverse=false){const rec=await source(r),a=reverse?f.b:f.a,b=reverse?f.a:f.b,dc=reverse?f.lane.aClient:f.lane.bClient,sc=reverse?f.lane.bClient:f.lane.aClient;const received=await receivePacket(a,b,dc,rec.report.packet),ack=await acknowledgePacket(a,b,sc,rec.report.packet,received.acknowledgement);const out=await f.call('ibc/reconcile',{id:r.id,destinationTxHash:received.result.hash,settlementTxHash:ack.hash});assert.equal(out.report.completed,true,out.report.reason);return out;}
test('real IBC A→B: wallet signature, escrow debit, voucher credit, client-verified ACK',async()=>{
 const before=await f.a.balance(f.accounts[0].address),dest=await f.b.balance(f.accounts[1].address,routeAssets(f.route).destinationDenom);const p=await prepare(0,'round-trip-out'),count=f.pa.submissions;
 assert.equal(f.pa.submissions,count);const r=await approve(p);assert.equal(f.pa.submissions,count+1);const src=await source(r);assert.equal(src.report.received,false);assert.equal(src.report.completed,false);assert.equal(src.report.stage,'awaiting-receive');
 delivered=await finish(r);assert.equal(delivered.report.stage,'reported-delivered');assert.equal(delivered.report.finalityProven,false);assert.equal(await f.a.balance(f.accounts[0].address),before-1050000n);assert.equal(await f.b.balance(f.accounts[1].address,routeAssets(f.route).destinationDenom),dest+1000000n);
});
test('same request returns durable bridge record; altered recipient/amount does not make another payment',async()=>{const c=f.pa.submissions;const p=await prepare(0,'round-trip-out');assert.equal(p.alreadyRecorded,true);assert.equal(p.record.id,delivered.id);assert.equal(f.pa.submissions,c);await assert.rejects(prepare(0,'round-trip-out',{amountAtomic:'2'}),/CONTENT_CONFLICT/);});
test('real return B→A burns the trace voucher and releases original stake',async()=>{
 const aBefore=await f.a.balance(f.accounts[0].address),bBefore=await f.b.balance(f.accounts[1].address,routeAssets(f.route).destinationDenom);returned=await finish(await approve(await prepare(1,'round-trip-return',{},true)),true);assert.equal(returned.report.received,true);assert.equal(await f.a.balance(f.accounts[0].address),aBefore+1000000n);assert.equal(await f.b.balance(f.accounts[1].address,routeAssets(f.route).destinationDenom),bBefore-1000000n);
});
test('owner approval binds the full destination chain and receiver; wallet connection capability cannot approve',async()=>{
 const p=await prepare(2,'wrong-confirmation'),count=f.pa.submissions;await assert.rejects(f.call('ibc/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.recipient,broadcast:true}),/CONFIRMATION/);assert.equal(f.pa.submissions,count);await f.call('reject',{id:p.id});
 const unauthorized=await fetch(f.started.origin+'/api/ibc/history',{method:'POST',headers:{origin:f.started.origin,'content-type':'application/json'},body:'{}'});assert.equal(unauthorized.status,401);
});
test('both RPCs reporting a wrong reciprocal channel are rejected before signing',async()=>{const count=f.pa.submissions;f.pb.mutate=({type,path,text})=>{if(type==='rest'&&path.startsWith('/ibc/core/channel/v1/channels/')){const j=JSON.parse(text);if(j.channel)j.channel.counterparty.channel_id='channel-999';return JSON.stringify(j);}return text;};try{await assert.rejects(prepare(3,'wrong-lane'),/CHANNEL_BINDING/);assert.equal(f.pa.submissions,count);}finally{f.pb.mutate=null;}});
test('corrupt commitment proof is rejected by ibc-go; replay cannot mint twice',async()=>{
 const r=await source(await approve(await prepare(3,'bad-proof'))),packet=r.report.packet,denom=routeAssets(f.route).destinationDenom,before=await f.b.balance(f.accounts[1].address,denom);
 await rejectedByChain(()=>receivePacket(f.a,f.b,f.lane.bClient,packet,{mutate:m=>{m.proof_commitment=Buffer.from('not an ICS23 proof').toString('base64');}}),/proof|unmarshal/i);assert.equal(await f.b.balance(f.accounts[1].address,denom),before);
 const good=await receivePacket(f.a,f.b,f.lane.bClient,packet);assert.equal(await f.b.balance(f.accounts[1].address,denom),before+1000000n);
 try{await receivePacket(f.a,f.b,f.lane.bClient,packet);}catch{}assert.equal(await f.b.balance(f.accounts[1].address,denom),before+1000000n);
 const ack=await acknowledgePacket(f.a,f.b,f.lane.aClient,packet,good.acknowledgement);const out=await f.call('ibc/reconcile',{id:r.id,destinationTxHash:good.result.hash,settlementTxHash:ack.hash});assert.equal(out.report.received,true,out.report.reason);
});
test('expired packet is not a refund; only a processed nonreceipt timeout restores source funds',async()=>{
 const before=await f.a.balance(f.accounts[2].address),r=await source(await approve(await prepare(2,'timeout',{timeoutSeconds:30}))),packet=r.report.packet;assert.equal(await f.a.balance(f.accounts[2].address),before-1050000n);
 await until(async()=>{const h=await f.b.head(),x=await f.b.rpc('block',{height:String(h)});return BigInt(Date.parse(x.block.header.time))*1000000n>BigInt(packet.timeout_timestamp);},40000);
 const elapsed=await f.call('ibc/reconcile',{id:r.id});assert.equal(elapsed.report.timeoutElapsed,true);assert.equal(elapsed.report.refunded,false);assert.equal(elapsed.report.completed,false);assert.equal(await f.a.balance(f.accounts[2].address),before-1050000n);
 const timeout=await timeoutPacket(f.a,f.b,f.lane.aClient,packet);const done=await f.call('ibc/reconcile',{id:r.id,settlementTxHash:timeout.hash});assert.equal(done.report.stage,'reported-refunded',done.report.reason);assert.equal(done.report.refunded,true);assert.equal(done.report.received,false);assert.equal(await f.a.balance(f.accounts[2].address),before-50000n);
 const balance=await f.a.balance(f.accounts[2].address);try{await timeoutPacket(f.a,f.b,f.lane.aClient,packet);}catch{}assert.equal(await f.a.balance(f.accounts[2].address),balance);
});
test('destination application error needs source ACK processing to refund',async()=>{
 const accounts=(await f.b.state('cosmos/auth/v1beta1/module_accounts')).accounts;const blocked=accounts.find(x=>x.name==='distribution').base_account.address,before=await f.a.balance(f.accounts[4].address);
 const r=await source(await approve(await prepare(4,'error-ack',{receiver:blocked}))),d=await receivePacket(f.a,f.b,f.lane.bClient,r.report.packet);assert.match(Buffer.from(d.acknowledgement,'base64').toString(),/error/);
 const middle=await f.call('ibc/reconcile',{id:r.id,destinationTxHash:d.result.hash});assert.equal(middle.report.completed,false);assert.equal(middle.report.refunded,false);assert.equal(await f.a.balance(f.accounts[4].address),before-1050000n);
 const ack=await acknowledgePacket(f.a,f.b,f.lane.aClient,r.report.packet,d.acknowledgement);const done=await f.call('ibc/reconcile',{id:r.id,settlementTxHash:ack.hash});assert.equal(done.report.refunded,true,done.report.reason);assert.equal(await f.a.balance(f.accounts[4].address),before-50000n);
});
test('lost source submission response preserves signature and recovers without another send',async()=>{
 const count=f.pa.submissions;f.pa.dropSubmit=true;let r;try{r=await approve(await prepare(5,'lost-response'));assert.equal(r.state,'broadcast-unknown');}finally{f.pa.dropSubmit=false;}
 const again=await prepare(5,'lost-response');assert.equal(again.alreadyRecorded,true);assert.equal(again.record.signed.txRawBase64,r.signed.txRawBase64);assert.equal(f.pa.submissions,count+1);const done=await finish(r);assert.equal(done.report.received,true);assert.equal(f.pa.submissions,count+1);
 await assert.rejects(f.call('ibc/submit',{id:r.id,confirmation:r.signed.requestId}),/RESUBMISSION/);
});
test('record-save failure locks wallet and does not send', async()=>{
 const p=await prepare(6,'save-failed');
 await assertStoreFailure({store:f.store.store,vault:f.vault,operation:()=>approve(p),
   submissions:()=>f.pa.submissions,unlock:()=>f.vault.unlock(PASSWORD)});
});
test('persisting broadcast-start failure leaves a durable unsent signature, never a hidden broadcast', async()=>{
 const r=await approve(await prepare(6,'broadcast-save-failed'),false);
 await assertStoreFailure({store:f.store.store,vault:f.vault,
   operation:()=>f.call('ibc/submit',{id:r.id,confirmation:r.signed.requestId}),
   submissions:()=>f.pa.submissions,unlock:()=>f.vault.unlock(PASSWORD)});
 const current=(await f.vault.nonEvmRecords()).find(v=>v.id===r.id);
 assert.equal(current.state,'signed');
 const sent=await f.call('ibc/submit',{id:r.id,confirmation:r.signed.requestId});
 assert.equal((await finish(sent)).report.received,true);
});
test('lock during zero-signature simulation cancels pending owner approval',async()=>{const p=await prepare(7,'lock-during'),count=f.pa.submissions;let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);f.pa.hook=async({type,path})=>{if(type==='rest'&&path==='/cosmos/tx/v1beta1/simulate'){entered();await gate;}};const pending=approve(p);try{await ready;await f.call('lock');release();await assert.rejects(pending,/LOCK|PROCESSING/);assert.equal(f.pa.submissions,count);}finally{release();f.pa.hook=null;await f.vault.unlock(PASSWORD);}});
test('changed ACK event withdraws delivered observation; old packet identity remains bound',async()=>{const hash=delivered.report.evidenceRefs.settlementTxHash;f.pa.mutate=({type,text})=>{if(type==='rpc'){const j=JSON.parse(text);if(j.result?.hash===hash){for(const e of j.result.tx_result.events)if(e.type==='acknowledge_packet')for(const a of e.attributes)if(a.key==='packet_sequence')a.value='9999';return JSON.stringify(j);}}return text;};try{const r=await f.call('ibc/reconcile',{id:delivered.id});assert.equal(r.report.received,false);assert.equal(r.report.completed,false);assert.equal(r.report.packet.sequence,delivered.report.packet.sequence);}finally{f.pa.mutate=null;}const correct=await f.call('ibc/reconcile',{id:delivered.id});assert.equal(correct.report.received,true,correct.report.reason);});
test('latest encrypted backup restores bridge journals and immutable sequence reservations',async()=>{const backup=await f.vault.backup(),store=storeFixture();try{const v=new Vault(store.store);await v.restore(backup.encrypted,PASSWORD);await v.unlock(PASSWORD);const original=await f.vault.nonEvmRecords(),restored=await v.nonEvmRecords();assert.deepEqual(restored,original);assert.ok(restored.some(r=>r.summary.operation==='cosmos-ibc-transfer-online'));v.lock();}finally{store.close();}});

test('received packet cannot claim timeout refund after deadline, then ACK settles without double payment',async()=>{
 const before=await f.a.balance(f.accounts[8].address),r=await source(await approve(await prepare(8,'received-no-refund',{timeoutSeconds:30}))),packet=r.report.packet;const d=await receivePacket(f.a,f.b,f.lane.bClient,packet);assert.equal(d.result.tx_result.code,0);
 await until(async()=>{const h=await f.b.head(),x=await f.b.rpc('block',{height:String(h)});return BigInt(Date.parse(x.block.header.time))*1000000n>BigInt(packet.timeout_timestamp);},40000);
 const x=await rejectedByChain(()=>timeoutPacket(f.a,f.b,f.lane.aClient,packet),/proof|receipt|received/i);assert.equal(await f.a.balance(f.accounts[8].address),before-1050000n);
 const partial=await f.call('ibc/reconcile',{id:r.id,destinationTxHash:d.result.hash,settlementTxHash:x.hash});assert.equal(partial.report.completed,false);assert.equal(partial.report.refunded,false);
 const ack=await acknowledgePacket(f.a,f.b,f.lane.aClient,packet,d.acknowledgement);const done=await f.call('ibc/reconcile',{id:r.id,destinationTxHash:d.result.hash,settlementTxHash:ack.hash});assert.equal(done.report.received,true,done.report.reason);assert.equal(done.report.refunded,false);
});
