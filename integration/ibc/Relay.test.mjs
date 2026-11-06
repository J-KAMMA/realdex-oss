/** Genuine two-chain packet execution; same-chain endpoints are two forwarders, not independent nodes. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ibcWalletFixture} from './wallet-fixture.mjs';
import {until} from './devnet.mjs';
import {spawn} from 'node:child_process';
import {recoverRelayLock} from '../../relay/recover-lock.mjs';
import {PASSWORD as WALLET_PASSWORD} from '../../wallet/test/fixtures.mjs';
import {RelayVault} from '../../relay/store.mjs';
import {RelayWorker} from '../../relay/engine.mjs';
import {RelayAdapter} from '../../relay/adapter.mjs';
import {POLICY_SCHEMA,relayNetworks} from '../../relay/policy.mjs';
import {runWithIbcFailureDiagnostic} from './failure-diagnostic.mjs';
const PASSWORD='Disposable relayer password only';let f,dir,v,w;
function policy(routes){return {schema:POLICY_SCHEMA,mode:'local-development',routes,fees:relayNetworks({routes}).map(n=>({networkId:n.id,feeAtomic:'50000',gasLimit:'5000000',maxTotalFeeAtomic:'2000000',maxTransactions:40})),maxJobs:32,intervalMs:1000,expiresAt:Date.now()+3600000};}
before(async()=>{f=await ibcWalletFixture(process.env.REALDEX_IBC_LOG_DIRECTORY?path.join(process.env.REALDEX_IBC_LOG_DIRECTORY,'relay'):undefined);dir=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-relay-it-'));v=new RelayVault(dir);await v.create(policy([f.route,f.reverse]),PASSWORD);
 for(const k of v.publicState().keys){const c=k.networkId===f.route.source.network.id?f.a:f.b;await c.tx([{'@type':'/cosmos.bank.v1beta1.MsgSend',from_address:c.relay,to_address:k.address,amount:[{denom:'stake',amount:'10000000'}]}]);}
 w=new RelayWorker(v);w.start();});
after(async()=>{w?.interrupt();v?.close();await f?.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});});
async function send(index,key,route=f.route,extra={}){return runWithIbcFailureDiagnostic(async()=>{const p=await f.call('ibc/prepare',{routeId:route.id,accountId:f.accounts[index].id,payment:f.payment(f.accounts[1].address,{requestKey:key,...extra})});return (await f.call('ibc/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.confirmationText,broadcast:true})).record;},()=>f.diagnosticReport());}
async function finish(id){return until(async()=>{const result=await w.tick();if(result.error)console.log('# relay diagnostic',result.error);const j=v.data.jobs.find(j=>j.id===id);assert.notEqual(j.status,'blocked',j.lastError);return j.status==='settled-observed'?j:false;},45000);}
test('dedicated encrypted relayer sends real receive and ACK; wallet observer recognizes the batch',async()=>{
 const r=await send(0,'persistent-first'),id=v.enqueue(f.route.id,r.signed.requestId);await finish(id);
 const j=v.data.jobs.find(j=>j.id===id),actions=v.data.actions.filter(a=>a.jobId===id);assert.equal(actions.length,2);assert.deepEqual(actions.map(a=>a.kind),['receive','acknowledge']);assert.ok(actions.every(a=>a.state==='included'));
 const observed=await f.call('ibc/track',{id:r.id});assert.equal(observed.report.received,true,observed.report.reason);assert.equal(observed.report.finalityProven,false);
 assert.equal(v.enqueue(f.route.id,r.signed.requestId),id);assert.equal(v.data.actions.length,2);
 const bytes=fs.readFileSync(v.store.file,'utf8');for(const k of v.data.keys)assert.ok(!bytes.includes(k.secretHex));assert.equal(j.packet.sequence,'1');
});
test('return voucher burns on B and unlocks original asset on A',async()=>{
 const before=await f.a.balance(f.accounts[1].address),r=await send(1,'persistent-return',f.reverse),id=v.enqueue(f.reverse.id,r.signed.requestId);await finish(id);
 const result=await f.call('ibc/track',{id:r.id});assert.equal(result.report.received,true,result.report.reason);assert.equal(await f.a.balance(f.accounts[1].address),before+1000000n);
});
test('elapsed but unreceived packet is refunded by a real timeout proof',async()=>{
 const before=await f.a.balance(f.accounts[2].address),r=await send(2,'persistent-timeout',f.route,{timeoutSeconds:30}),id=v.enqueue(f.route.id,r.signed.requestId);
 w.stop();await until(async()=>{const b=await f.b.rpc('block',{height:String(await f.b.head())});return BigInt(Date.parse(b.block.header.time))*1000000n>BigInt(r.summary.transfer.timeoutTimestamp)+100000000n;},40000);w.start();await finish(id);
 const observed=await f.call('ibc/track',{id:r.id});assert.equal(observed.report.refunded,true,observed.report.reason);assert.equal(await f.a.balance(f.accounts[2].address),before-50000n);assert.deepEqual(v.data.actions.filter(a=>a.jobId===id).map(a=>a.kind),['timeout']);
});
test('failed application receive emits error ACK and refunds only after source execution',async()=>{
 const blocked=(await f.b.state('cosmos/auth/v1beta1/module_accounts')).accounts.find(a=>a.name==='distribution').base_account.address;
 const before=await f.a.balance(f.accounts[3].address),r=await send(3,'persistent-error-ack',f.route,{receiver:blocked}),id=v.enqueue(f.route.id,r.signed.requestId);await finish(id);
 const observed=await f.call('ibc/track',{id:r.id});assert.equal(observed.report.refunded,true,observed.report.reason);assert.equal(await f.a.balance(f.accounts[3].address),before-50000n);
});
test('wallet can remain locked while fee-only relayer finishes receive and ACK',async()=>{
 const r=await send(4,'persistent-wallet-locked'),id=v.enqueue(f.route.id,r.signed.requestId);await f.call('lock');
 try{await finish(id);assert.equal(f.vault.status().locked,true);}finally{await f.vault.unlock(WALLET_PASSWORD);}
 assert.equal((await f.call('ibc/track',{id:r.id})).report.received,true);
});
test('accepted transaction with lost response is reconciled after encrypted restart, never retransmitted',async()=>{
 const r=await send(5,'persistent-lost-response'),id=v.enqueue(f.route.id,r.signed.requestId);await f.a.waitHeight((await f.a.head())+2);const count=f.pb.submissions;
 f.pb.dropSubmit=true;
 try{await w.tick();}finally{f.pb.dropSubmit=false;}
 let a=v.data.actions.find(a=>a.jobId===id);assert.ok(a);assert.equal(a.state,'broadcast-unknown');const raw=a.txRawBase64;
 w.stop();v.close();v=new RelayVault(dir);await v.unlock(PASSWORD);w=new RelayWorker(v);w.start();await finish(id);
 assert.equal(f.pb.submissions-count,1);assert.equal(v.data.actions.find(a=>a.jobId===id).txRawBase64,raw);assert.equal((await f.call('ibc/track',{id:r.id})).report.received,true);
});
test('stop during send revalidation preserves signed bytes and charges only one reservation',async()=>{
 const r=await send(6,'persistent-stop-signed'),id=v.enqueue(f.route.id,r.signed.requestId);await f.a.waitHeight((await f.a.head())+2);
 const original=w.adapter.revalidate.bind(w.adapter);let n=0,enter,release;const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 w.adapter.revalidate=async(...args)=>{if(++n===2){enter();await gate;}return original(...args);};
 const count=f.pb.submissions,task=w.tick();await ready;const a=v.data.actions.find(a=>a.jobId===id);assert.equal(a.state,'signed');const raw=a.txRawBase64;w.stop();release();await assert.rejects(task,/STOPPED/);assert.equal(f.pb.submissions,count);
 w.adapter=new RelayAdapter();w.start();await finish(id);assert.equal(v.data.actions.filter(a=>a.jobId===id&&a.kind==='receive').length,1);assert.equal(v.data.actions.find(a=>a.jobId===id).txRawBase64,raw);
});
test('SIGKILL after send journal commit recovers by tx hash without duplicate relay',async()=>{
 const r=await send(7,'persistent-crash-child'),id=v.enqueue(f.route.id,r.signed.requestId);await f.a.waitHeight((await f.a.head())+2);
 const hash=v.data.policyHash,count=f.pb.submissions;w.stop();v.close();let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 f.pb.hook=async x=>{if(x.peer===0&&x.type==='rest'&&x.path==='/cosmos/tx/v1beta1/txs'){entered();await gate;}};
 const child=spawn(process.execPath,['relay/cli.mjs','start','--once','--directory',dir,'--password-fd','0','--confirm',hash],{cwd:new URL('../../',import.meta.url),env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',LANG:'C'},stdio:['pipe','ignore','pipe']});
 let errors='';child.stderr.on('data',x=>errors+=x);const exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));child.stdin.end(PASSWORD);
 try{
  await Promise.race([ready,exited.then(x=>{throw Error('child exited before submission '+x.code+' '+errors);})]);child.kill('SIGKILL');const exit=await exited;assert.equal(exit.signal,'SIGKILL');release();f.pb.hook=null;
  assert.ok(fs.existsSync(path.join(dir,'writer.lock')));recoverRelayLock(dir,child.pid);
  v=new RelayVault(dir);await v.unlock(PASSWORD);assert.equal(v.data.actions.find(a=>a.jobId===id).state,'broadcast-unknown');w=new RelayWorker(v);w.start();await finish(id);
  assert.equal(f.pb.submissions-count,1);assert.equal((await f.call('ibc/track',{id:r.id})).report.received,true);
 }finally{release();f.pb.hook=null;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});
test('non-IBC source transaction is blocked without spending relayer fee',async()=>{
 const before=v.data.actions.length,r=await f.a.tx([{'@type':'/cosmos.bank.v1beta1.MsgSend',from_address:f.a.relay,to_address:f.accounts[8].address,amount:[{denom:'stake',amount:'1'}]}]),id=v.enqueue(f.route.id,r.hash);
 await until(async()=>{await w.tick();return v.data.jobs.find(j=>j.id===id).status==='blocked';});assert.equal(v.data.actions.length,before);assert.equal(v.data.jobs.find(j=>j.id===id).lastError,'RELAY_SOURCE_NOT_TRANSFER');
});
test('signed fee counters equal real relay fees and survive reopening; all jobs stay deduplicated',async()=>{
 const status=v.publicState();for(const b of status.budgets){const key=status.keys.find(k=>k.networkId===b.networkId),c=key.networkId===f.route.source.network.id?f.a:f.b;assert.equal(await c.balance(key.address),10000000n-BigInt(b.reservedFeeAtomic));}
 const before=v.data.actions.length;for(const j of v.data.jobs)assert.equal(v.enqueue(j.routeId,j.sourceTxHash),j.id);await w.tick();assert.equal(v.data.actions.length,before);
 w.stop();v.close();v=new RelayVault(dir);await v.unlock(PASSWORD);assert.deepEqual(v.publicState().budgets,status.budgets);w=new RelayWorker(v);assert.equal(w.active,false);
});
