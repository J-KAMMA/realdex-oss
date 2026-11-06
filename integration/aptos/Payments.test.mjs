/** Real Aptos VM execution. Single validator, two forwarding URLs, disposable value only. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startAptos} from './fixture.mjs';
let chain;
before(async()=>{chain=await startAptos();});
after(async()=>{await chain?.close();});
test('real Aptos owner approval executes APT transfer and exact balance/fee deltas',async t=>{
 const f=await chain.fixture({secretHex:'31'.repeat(32),recipientSeed:Buffer.alloc(32,0x32)});t.after(()=>f.close());
 const source=await f.balance(f.account.address),destination=await f.balance();
 const p=await f.prepare();assert.equal(chain.state.sent,f.startSent);assert.equal((await f.vault.nonEvmRecords()).length,0);
 const {record}=await f.approve(p,true);assert.equal(record.state,'broadcast');
 const r=await f.settle(record);assert.equal(r.report.received,true);assert.equal(r.report.finalityProven,false);
 assert.equal(await f.balance()-destination,1000000n);assert.equal(source-await f.balance(f.account.address),1000000n+BigInt(r.report.feeAtomic));
 assert.ok(chain.state.simulations>=2);assert.ok(chain.state.simulationSignatures.every(s=>s==='00'.repeat(64)));assert.equal(chain.state.sent,f.startSent+1);
});

async function setup(t,opts){const f=await chain.fixture(opts);t.after(()=>f.close());return f;}
async function waitUntil(check){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}throw Error('TEST_WAIT_EXPIRED');}

test('real Aptos normalizes leading-zero sender and recipient from actual node responses',async t=>{
 const {keyInfo}=await import('../../wallet/lib/keys.mjs');const seeds=[];
 for(let i=1;i<256&&seeds.length<2;i++){const b=Buffer.alloc(32,i);if(keyInfo('aptos',b).address.startsWith('0x0'))seeds.push(b);}
 assert.equal(seeds.length,2);const f=await setup(t,{secretHex:seeds[0].toString('hex'),recipientSeed:seeds[1]});
 assert.ok(f.account.address.startsWith('0x0'));assert.ok(f.to.startsWith('0x0'));
 const {record}=await f.approve(await f.prepare(),true);const r=await f.settle(record);assert.equal(r.report.received,true);
});
test('real Aptos same-key retry reuses the confirmed record without a second submission',async t=>{
 const f=await setup(t),{record}=await f.approve(await f.prepare(),true);await f.settle(record);
 assert.equal((await f.prepare()).alreadyRecorded,true);assert.equal(chain.state.sent,f.startSent+1);
 await assert.rejects(f.prepare({amountAtomic:'1000001'}),/PAYMENT_KEY_CONTENT_CONFLICT/);
});
test('real Aptos sign-only is durable and initial-send requires the exact transaction id',async t=>{
 const f=await setup(t),{record}=await f.approve(await f.prepare());assert.equal(chain.state.sent,f.startSent);
 await assert.rejects(f.call('non-evm/account-online/submit',{id:record.id,confirmation:'wrong'}),/ACCOUNT_TXID_CONFIRMATION_REQUIRED/);
 const sent=await f.call('non-evm/account-online/submit',{id:record.id,confirmation:record.signed.requestId});
 assert.equal((await f.settle(sent)).report.received,true);
 await assert.rejects(f.call('non-evm/account-online/submit',{id:record.id,confirmation:record.signed.requestId}),/ACCOUNT_REBROADCAST_NOT_IMPLEMENTED/);
});
test('real Aptos accepted transfer with lost HTTP response reconciles without resend',async t=>{
 const f=await setup(t);chain.state.drop=true;const {record}=await f.approve(await f.prepare(),true);
 assert.equal(record.state,'broadcast-unknown');assert.equal(chain.state.sent,f.startSent+1);
 assert.equal((await f.settle(record)).report.received,true);assert.equal(chain.state.sent,f.startSent+1);
});
test('real Aptos insufficient native balance blocks signing and no real signature reaches simulation',async t=>{
 const f=await setup(t,{fundingAmount:'1000000'});
 await assert.rejects(f.prepare(),/APTOS_INSUFFICIENT_BALANCE/);assert.equal(chain.state.sent,f.startSent);
 assert.equal((await f.vault.nonEvmRecords()).length,0);
});
test('real Aptos low gas budget is rejected by VM simulation before wallet signing',async t=>{
 const f=await setup(t);await assert.rejects(f.prepare({maxGasAmount:'1'}));
 assert.equal(chain.state.sent,f.startSent);assert.equal((await f.vault.nonEvmRecords()).length,0);
 assert.ok(chain.state.simulationSignatures.every(s=>s==='00'.repeat(64)));
});
test('real Aptos nonce consumption by a separate signed transaction invalidates a prepared payment',async t=>{
 const f=await setup(t),p=await f.prepare();
 const {signAptosPayment}=await import('../../wallet/non-evm/aptos-offline.mjs');
 const secret=f.vault.account(f.account.id).secretHex;
 const payment={...p.summary.transfer,amountAtomic:'1'};
 const other=signAptosPayment(Buffer.from(secret,'hex'),payment);
 const r=await fetch(chain.root+'/transactions',{method:'POST',headers:{'content-type':'application/x.aptos.signed_transaction+bcs'},body:Buffer.from(other.signedTransactionHex,'hex')});assert.equal(r.status,202);
 for(let i=0;i<100;i++){const d=await (await fetch(chain.root+'/transactions/by_hash/'+other.requestId)).json();if(d.type==='user_transaction'){assert.equal(d.success,true);break;}await new Promise(r=>setTimeout(r,50));}
 await assert.rejects(f.approve(p,true),/ACCOUNT_SEQUENCE_CHANGED/);assert.equal(chain.state.sent,f.startSent);assert.equal((await f.vault.nonEvmRecords()).length,0);
});
test('real Aptos lock during simulation prevents a late approval from signing',async t=>{
 const f=await setup(t),p=await f.prepare();let release,entered=false;const hold=new Promise(r=>release=r);
 chain.state.hold=async url=>{if(url.startsWith('/v1/transactions/simulate')){entered=true;await hold;}};
 const pending=f.approve(p,true).then(()=>null,e=>e);await waitUntil(()=>entered);await f.call('lock');release();
 assert.ok(await pending instanceof Error);assert.equal(chain.state.sent,f.startSent);
});
test('real Aptos durable write failure stops submission and locks the vault',async t=>{
 const f=await setup(t),p=await f.prepare(),write=f.store.write;
 f.store.write=()=>{throw Error('TEST_WRITE_FAILURE');};
 try{await assert.rejects(f.approve(p,true));}finally{f.store.write=write;}
 assert.equal(chain.state.sent,f.startSent);assert.equal(f.vault.status().locked,true);
});
test('real Aptos altered recipient in an otherwise valid receipt retracts success observation',async t=>{
 const f=await setup(t),{record}=await f.approve(await f.prepare(),true);await f.settle(record);
 chain.state.mutate=(d,{url})=>{if(url.startsWith('/v1/transactions/by_')&&d.payload)d.payload.arguments[0]=f.account.address;};
 const r=await f.call('non-evm/account-online/reconcile',{id:record.id});assert.equal(r.report.received,false);assert.equal(r.state,'broadcast-unknown');
 await assert.rejects(f.prepare({requestKey:'after-invalid-proof'}),/ACCOUNT_UNRESOLVED_TRANSFER/);
});
test('real Aptos inconsistent success status retracts a previously accepted receipt',async t=>{
 const f=await setup(t),{record}=await f.approve(await f.prepare(),true);await f.settle(record);
 chain.state.mutate=(d,{url})=>{if(url.startsWith('/v1/transactions/by_'))d.vm_status='Move abort: injected inconsistent result';};
 const r=await f.call('non-evm/account-online/reconcile',{id:record.id});assert.equal(r.report.received,false);assert.equal(r.state,'broadcast-unknown');
});
test('real Aptos unavailable or malformed historical state does not create receipt confirmation',async t=>{
 const f=await setup(t),{record}=await f.approve(await f.prepare(),true);await f.settle(record);
 chain.state.mutate=(d,{url})=>{if(url.startsWith('/v1/view?ledger_version=')&&Array.isArray(d))d[0]='0';};
 const r=await f.call('non-evm/account-online/reconcile',{id:record.id});assert.equal(r.report.received,false);assert.equal(r.state,'broadcast-unknown');
});
test('real Aptos fixed checkpoint mismatch prevents signing',async t=>{
 const f=await setup(t);chain.state.mutate=(d,{url})=>{if(url.startsWith('/v1/blocks/by_height/1?'))d.block_hash='0x'+'ab'.repeat(32);};
 await assert.rejects(f.prepare(),/ACCOUNT_CHECKPOINT_MISMATCH/);assert.equal(chain.state.sent,f.startSent);
});
test('real Aptos network policy change invalidates a saved unsent signature',async t=>{
 const f=await setup(t),{record}=await f.approve(await f.prepare());
 f.app.settings.accountNetworks=[{...chain.network,maxTransferAtomic:'99999999'}];
 await assert.rejects(f.call('non-evm/account-online/submit',{id:record.id,confirmation:record.signed.requestId}),/ACCOUNT_RECORD_NETWORK_CHANGED/);assert.equal(chain.state.sent,f.startSent);
});
test('real Aptos restart retains the signed bytes and sequence reservation',async t=>{
 const f=await setup(t),{record}=await f.approve(await f.prepare());
 const dir=f.store.directory;await f.app.close();
 const {PrivateStore}=await import('../../wallet/lib/storage.mjs');const {Vault}=await import('../../wallet/lib/vault.mjs');
 const {WalletServer}=await import('../../wallet/lib/server.mjs');const {PASSWORD}=await import('./fixture.mjs');
 const store=new PrivateStore(dir),vault=new Vault(store);await vault.unlock(PASSWORD);
 const app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],accountNetworks:[chain.network],allowedAppOrigins:[]}});
 t.after(()=>app.close());const records=await vault.nonEvmRecords();assert.equal(records[0].signed.signedTransactionHex,record.signed.signedTransactionHex);
 const engine=app.nonEvm.accountEngine;assert.throws(()=>engine.unresolved(records,chain.network,{address:f.account.address}),/ACCOUNT_UNRESOLVED_TRANSFER/);
 assert.equal(chain.state.sent,f.startSent);await app.close();
});
