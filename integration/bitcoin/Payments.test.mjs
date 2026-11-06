import test,{before,after} from 'node:test';import assert from 'node:assert/strict';
import {startCore,fixture,RECIPIENT} from './fixture.mjs';
import {signBitcoinPayment} from '../../wallet/non-evm/bitcoin-offline.mjs';
import {parseBitcoinTransaction} from '../../wallet/non-evm/bitcoin-codec.mjs';
import {btcSatoshis} from '../../wallet/non-evm/bitcoin-network.mjs';
import {storeFixture,PASSWORD} from '../../wallet/test/fixtures.mjs';import {Vault} from '../../wallet/lib/vault.mjs';
let chain;before(async()=>{chain=await startCore();});after(async()=>{await chain?.close();});
test('Core: scan, owner review, signature, mempool acceptance and exact outputs/change/fee',async t=>{
  const f=await fixture(t,chain),p=await f.prepare();assert.equal((await f.vault.nonEvmRecords()).length,0);assert.equal(f.sent.length,0);
  const {record}=await f.approve(p);assert.equal(record.state,'broadcast');assert.equal(f.sent.length,1);
  const raw=await chain.rpc('getrawtransaction',[record.signed.requestId]);assert.equal(raw,record.signed.rawTransactionHex);
  const decoded=parseBitcoinTransaction(raw);assert.equal(decoded.outputs[0].amountAtomic,'100000');assert.equal(BigInt(f.payment.utxos[0].amountAtomic)-decoded.outputs.reduce((a,o)=>a+BigInt(o.amountAtomic),0n),1000n);
  assert.equal((await f.reconcile(record)).report.received,false);await f.mine(1);assert.equal((await f.reconcile(record)).report.received,false);await f.mine(1);
  const result=await f.reconcile(record);assert.equal(result.state,'reported-confirmed');assert.equal(result.report.received,true);assert.equal(result.report.inclusion,true);assert.equal(result.report.finalityProven,false);
  const out=await chain.rpc('gettxout',[record.signed.requestId,0,true]);assert.equal(btcSatoshis(String(out.value)),'100000');
});
test('Core: repeated payment key never signs or submits twice; changed content rejected',async t=>{
  const f=await fixture(t,chain),one=await f.approve(await f.prepare()),two=await f.prepare();assert.equal(two.record.id,one.record.id);assert.equal(f.sent.length,1);await assert.rejects(f.prepare({amountAtomic:'100001'}),/PAYMENT_KEY_CONTENT_CONFLICT/);
  await assert.rejects(f.owner('non-evm/bitcoin-online/submit',{id:one.record.id,confirmation:one.record.signed.requestId}),/BITCOIN_REBROADCAST_NOT_IMPLEMENTED/);assert.equal(f.sent.length,1);
});
test('Core: response lost AFTER actual acceptance keeps bytes and reconciles without retransmission',async t=>{
  const f=await fixture(t,chain);f.fault.drop=true;const {record}=await f.approve(await f.prepare());assert.equal(record.state,'broadcast-unknown');assert.equal(f.sent.length,1);assert.equal(await chain.rpc('getrawtransaction',[record.signed.requestId]),record.signed.rawTransactionHex);await f.mine();assert.equal((await f.reconcile(record)).report.received,true);await f.prepare();assert.equal(f.sent.length,1);
});
test('Core: immature coinbase is refused before signature',async t=>{
  const f=await fixture(t,chain),u=f.scan.utxos.find(u=>u.coinbase&&u.confirmations===2);assert.ok(u);
  const {txid,vout,amountAtomic,scriptHex}=u;await assert.rejects(f.prepare({utxos:[{txid,vout,amountAtomic,scriptHex}]}),/BITCOIN_IMMATURE_COINBASE/);assert.equal(f.sent.length,0);
});
test('Core: unsigned review does not reserve; first sign reserves outpoint across requests',async t=>{
  const f=await fixture(t,chain),a=await f.prepare(),b=await f.prepare({requestKey:'other'});await f.approve(a,false);await assert.rejects(f.approve(b,false),/BITCOIN_OUTPOINT_ALREADY_RESERVED/);assert.equal(f.sent.length,0);assert.equal((await f.vault.nonEvmRecords()).length,1);
});
test('Core: input spent after review is rejected at signing',async t=>{
  const f=await fixture(t,chain),p=await f.prepare();
  const secret=Buffer.from(f.vault.account(f.account.id).secretHex,'hex');let signed;try{signed=signBitcoinPayment(secret,p.summary.transfer);}finally{secret.fill(0);}
  await chain.rpc('sendrawtransaction',[signed.rawTransactionHex]);await assert.rejects(f.approve(p),/BITCOIN_INPUT_SPENT_OR_MISSING/);assert.equal((await f.vault.nonEvmRecords()).length,0);assert.equal(f.sent.length,0);
});
test('Core: sign-only then owner txid confirmation submits the stored bytes exactly once',async t=>{
  const f=await fixture(t,chain),{record}=await f.approve(await f.prepare(),false);assert.equal(f.sent.length,0);await assert.rejects(f.owner('non-evm/bitcoin-online/submit',{id:record.id,confirmation:'wrong'}),/BITCOIN_TXID_CONFIRMATION_REQUIRED/);
  const r=await f.owner('non-evm/bitcoin-online/submit',{id:record.id,confirmation:record.signed.requestId});assert.equal(r.state,'broadcast');assert.equal(f.sent[0],record.signed.rawTransactionHex);
});
test('Core: block invalidation retracts confirmation; signed outpoints remain reserved',async t=>{
  const f=await fixture(t,chain),{record}=await f.approve(await f.prepare());await f.mine();const confirmed=await f.reconcile(record);assert.equal(confirmed.report.received,true);
  await chain.rpc('invalidateblock',[confirmed.report.blockHash]);await chain.sync();const rolled=await f.reconcile(record);assert.equal(rolled.report.received,false);assert.notEqual(rolled.state,'reported-confirmed');assert.equal(rolled.signed.rawTransactionHex,record.signed.rawTransactionHex);assert.equal(f.sent.length,1);await assert.rejects(f.prepare({requestKey:'replacement'}),/BITCOIN_OUTPOINT_ALREADY_RESERVED/);
  await chain.rpc('reconsiderblock',[confirmed.report.blockHash]);await chain.sync();
});
test('Core: lock during UTXO recheck cancels approval without signing',async t=>{
  const f=await fixture(t,chain),p=await f.prepare();let entered,release;const hit=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.fault.before=async m=>{if(m==='gettxout'){entered();await gate;}};
  const result=f.approve(p).then(()=>null,e=>e);await hit;await f.owner('lock');release();assert.match((await result).message,/LOCK|VAULT/);f.fault.before=null;await f.owner('unlock',{password:PASSWORD});assert.equal((await f.vault.nonEvmRecords()).length,0);assert.equal(f.sent.length,0);
});
test('Core: persistence failure stops before any broadcast and locks the vault',async t=>{
  const f=await fixture(t,chain),p=await f.prepare(),write=f.store.write.bind(f.store);f.store.write=()=>{throw Error('INJECTED_STORAGE_FAILURE');};await assert.rejects(f.approve(p),/INJECTED_STORAGE_FAILURE/);assert.equal(f.sent.length,0);assert.equal(f.vault.status().locked,true);f.store.write=write;await f.owner('unlock',{password:PASSWORD});assert.equal((await f.vault.nonEvmRecords()).length,0);
});
test('Core: checkpoint mismatch and a lying UTXO endpoint fail before signature',async t=>{
  const f=await fixture(t,chain);f.fault.mutate=(r,m,i)=>{if(m==='getblockhash'&&i===1)r.result='a'.repeat(64);return r;};await assert.rejects(f.prepare(),/BITCOIN_GENESIS_MISMATCH/);
  f.fault.mutate=(r,m,i)=>{if(m==='gettxout'&&r.result&&i===1)r.result.value=1;return r;};await assert.rejects(f.prepare(),/BITCOIN_UTXO_CONTENT_MISMATCH/);assert.equal(f.sent.length,0);
});
test('Core: transaction or block evidence modification retracts received observation',async t=>{
  const f=await fixture(t,chain),{record}=await f.approve(await f.prepare());await f.mine();assert.equal((await f.reconcile(record)).report.received,true);
  f.fault.mutate=(r,m,i)=>{if(m==='getblock'&&i===1&&r.result?.tx)r.result.tx=['b'.repeat(64)];return r;};const r=await f.reconcile(record);assert.equal(r.report.received,false);assert.equal(r.state,'broadcast-unknown');assert.equal(r.report.reason,'BITCOIN_TX_NOT_IN_BLOCK');assert.equal(f.sent.length,1);
});
test('Core: encrypted restoration preserves Bitcoin signature and spent outpoint reservations',async t=>{
  const f=await fixture(t,chain),{record}=await f.approve(await f.prepare(),false),backup=await f.vault.backup(),other=storeFixture(),v=new Vault(other.store);t.after(()=>{v.lock();other.close();});await v.restore(backup.encrypted,PASSWORD);await v.unlock(PASSWORD);assert.equal((await v.nonEvmRecords())[0].signed.rawTransactionHex,record.signed.rawTransactionHex);const b=await v.backup();await v.verifyBackup(b.encrypted,PASSWORD);
  const next=await f.server.nonEvm.bitcoinEngine.prepare(f.network,v.account(f.account.id),{...f.payment,requestKey:'restored-other'});await assert.rejects(f.server.nonEvm.bitcoinEngine.sign(v,f.network,next),/BITCOIN_OUTPOINT_ALREADY_RESERVED/);
});
test('Core: lock during mempool preflight retains the saved signature but sends nothing',async t=>{
  const f=await fixture(t,chain),p=await f.prepare();let entered,release;const hit=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.fault.before=async m=>{if(m==='testmempoolaccept'){entered();await gate;}};
  const outcome=f.approve(p).then(()=>null,e=>e);await hit;await f.owner('lock');release();assert.match((await outcome).message,/LOCK|VAULT/);f.fault.before=null;await f.owner('unlock',{password:PASSWORD});const h=await f.vault.nonEvmRecords();assert.equal(h.length,1);assert.equal(h[0].state,'signed');assert.equal(f.sent.length,0);
});
test('Core: late RPC acceptance response cannot cross a lock/re-unlock epoch',async t=>{
  const f=await fixture(t,chain),p=await f.prepare();let entered,release;const hit=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.fault.after=async m=>{if(m==='sendrawtransaction'){entered();await gate;}};
  const outcome=f.approve(p).then(()=>null,e=>e);await hit;await f.owner('lock');await f.owner('unlock',{password:PASSWORD});release();assert.match((await outcome).message,/LOCK|VAULT/);f.fault.after=null;
  const r=(await f.vault.nonEvmRecords())[0];assert.equal(r.state,'broadcast-unknown');assert.equal(f.sent.length,1);await f.mine();assert.equal((await f.reconcile(r)).report.received,true);assert.equal(f.sent.length,1);
});
test('Core: failure persisting submission intent leaves signed record and prevents network send',async t=>{
  const f=await fixture(t,chain),p=await f.prepare(),write=f.store.write.bind(f.store);let n=0;f.store.write=(...args)=>{if(++n===2)throw Error('INJECTED_INTENT_SAVE_FAILURE');return write(...args);};
  await assert.rejects(f.approve(p),/INJECTED_INTENT_SAVE_FAILURE/);f.store.write=write;assert.equal(f.sent.length,0);assert.equal(f.vault.status().locked,true);await f.owner('unlock',{password:PASSWORD});assert.equal((await f.vault.nonEvmRecords())[0].state,'signed');
});
test('Core: offline Bitcoin signatures cannot be silently promoted into online submit capability',async t=>{
  const f=await fixture(t,chain),p=await f.owner('non-evm/bitcoin/prepare',{accountId:f.account.id,payment:{...f.payment,networkId:'bitcoin:regtest',acknowledgeUnverifiedState:true}}),a=await f.approve(p,false);
  await assert.rejects(f.owner('non-evm/bitcoin-online/submit',{id:a.record.id,confirmation:a.record.signed.requestId}),/BITCOIN_ONLINE_RECORD_REQUIRED/);assert.equal(f.sent.length,0);
});
test('Core: wrong owner capability, origin, and recipient confirmation cannot request a send',async t=>{
  const f=await fixture(t,chain);for(const extra of [{authorization:'Bearer '+'0'.repeat(64)},{origin:'http://127.0.0.1:1234'}]){
    const response=await fetch(f.started.origin+'/api/non-evm/bitcoin-online/utxos',{method:'POST',headers:{origin:f.started.origin,authorization:'Bearer '+f.server.uiToken,'content-type':'application/json',...extra},body:JSON.stringify({accountId:f.account.id,networkId:f.network.id})});assert.ok(response.status>=400);
  }
  const p=await f.prepare();await assert.rejects(f.owner('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:'incorrect',broadcast:true}),/TRANSACTION_CONFIRMATION_MISMATCH/);assert.equal((await f.vault.nonEvmRecords()).length,0);assert.equal(f.sent.length,0);
});
test('Core: server-reported wrong txid is unknown, then exact chain bytes settle it',async t=>{
  const f=await fixture(t,chain);f.fault.mutate=(r,m)=>{if(m==='sendrawtransaction')r.result='ee'.repeat(32);return r;};const {record}=await f.approve(await f.prepare());assert.equal(record.state,'broadcast-unknown');assert.equal(record.report.reason,'BITCOIN_RPC_TXID_MISMATCH');f.fault.mutate=null;await f.mine();assert.equal((await f.reconcile(record)).report.received,true);assert.equal(f.sent.length,1);
});
test('Core: expiry and changed configured fingerprint fail before signature',async t=>{
  const f=await fixture(t,chain),p=await f.prepare();f.clock.value+=60001;await assert.rejects(f.approve(p),/CONFIRMATION|PENDING|EXPIRED/);assert.equal((await f.vault.nonEvmRecords()).length,0);
  const intent=await f.server.nonEvm.bitcoinEngine.prepare(f.network,f.vault.account(f.account.id),f.payment);
  await assert.rejects(f.server.nonEvm.bitcoinEngine.sign(f.vault,{...f.network,maxFeeSats:'90000'},intent),/BITCOIN_INTENT_CHANGED/);assert.equal(f.sent.length,0);
});
test('Core: configuration collector is read-only, defaults to broadcast OFF, and never overwrites',async t=>{
  const f=await fixture(t,chain),{execFile}=await import('node:child_process'),{promisify}=await import('node:util'),fs=await import('node:fs'),path=await import('node:path');
  const run=promisify(execFile),output=path.join(f.directory,'collected.json'),args=['wallet/non-evm/bitcoin-config.mjs',...f.network.rpcUrls.flatMap(u=>['--rpc-url',u]),'--cookie-file',f.network.cookieFile,'--checkpoint-height','1','--output',output];
  const result=await run(process.execPath,args);const config=JSON.parse(fs.readFileSync(output,'utf8'));assert.equal(config.broadcastEnabled,false);assert.equal(config.checkpoint.hash,f.network.checkpoint.hash);assert.equal(JSON.parse(result.stdout).cookieContentsExported,false);assert.equal(f.sent.length,0);
  await assert.rejects(run(process.execPath,args));assert.equal(JSON.parse(fs.readFileSync(output,'utf8')).broadcastEnabled,false);
});
