import test from 'node:test';
import assert from 'node:assert/strict';
import {accountOnlineFixture} from './account-online-fixtures.mjs';
import {PASSWORD,waitFor} from './fixtures.mjs';
import {validateAccountNetwork,AccountRest,decimalAtomic} from '../non-evm/account-network.mjs';
import {validateNonEvmRecord} from '../non-evm/records.mjs';
import {Vault} from '../lib/vault.mjs';
async function setup(t,family){const f=await accountOnlineFixture(family);t.after(()=>f.close());return f;}
for(const family of ['stellar','aptos']){
  test(`${family}: native balance and sequence are read, no signature produced`,async t=>{
    const f=await setup(t,family),r=await f.call('non-evm/account-online/balance',{accountId:f.account.id,networkId:f.network.id});
    assert.equal(r.account.sequence,'7');assert.equal(r.account.balanceAtomic,'10000000000');assert.equal(r.finalityProven,false);assert.equal(f.state.sent,0);
  });
  test(`${family}: owner prepare/sign/persist/submit/reconcile via actual HTTP`,async t=>{
    const f=await setup(t,family),p=await f.prepare();assert.equal(f.state.sent,0);assert.equal((await f.vault.nonEvmRecords()).length,0);
    const a=await f.approve(p,true);assert.equal(a.record.state,'broadcast');assert.equal(f.state.sent,1);assert.equal(f.state.signaturesVerified,1);
    const r=await f.reconcile(a.record);assert.equal(r.state,'reported-confirmed');assert.equal(r.report.received,true);assert.equal(r.report.finalityProven,false);
    assert.equal(r.report.balanceDeltaVerified,family==='aptos');assert.equal(f.state.toBalance,2001000000n);
  });
  test(`${family}: confirmed same-key request returns old record without RPC or a new signature`,async t=>{
    const f=await setup(t,family),r=await f.approve(await f.prepare(),true);await f.reconcile(r.record);const count=f.state.calls.length;
    const again=await f.prepare();assert.equal(again.alreadyRecorded,true);assert.equal(f.state.calls.length,count);assert.equal(f.state.sent,1);
    await assert.rejects(f.prepare({amountAtomic:'1000001'}),/PAYMENT_KEY_CONTENT_CONFLICT/);
  });
  test(`${family}: sign-only and initial submit are separated, repeat broadcast refused`,async t=>{
    const f=await setup(t,family),{record:r}=await f.approve(await f.prepare());assert.equal(r.state,'signed');assert.equal(f.state.sent,0);
    await assert.rejects(f.call('non-evm/account-online/submit',{id:r.id,confirmation:'bad'}),/ACCOUNT_TXID_CONFIRMATION_REQUIRED/);
    const x=await f.call('non-evm/account-online/submit',{id:r.id,confirmation:r.signed.requestId});assert.equal(x.state,'broadcast');
    await assert.rejects(f.call('non-evm/account-online/submit',{id:r.id,confirmation:r.signed.requestId}),/ACCOUNT_REBROADCAST_NOT_IMPLEMENTED/);
  });
  test(`${family}: unknown accepted response is durable and resolved without resend`,async t=>{
    const f=await setup(t,family);f.state.drop=true;const {record:r}=await f.approve(await f.prepare(),true);assert.equal(r.state,'broadcast-unknown');
    await assert.rejects(f.prepare({requestKey:'different'}),/ACCOUNT_UNRESOLVED_TRANSFER/);
    const result=await f.reconcile(r);assert.equal(result.report.received,true);assert.equal(f.state.sent,1);
  });
  test(`${family}: missing former receipt retracts success and retains the sequence`,async t=>{
    const f=await setup(t,family),{record:r}=await f.approve(await f.prepare(),true);await f.reconcile(r);f.state.hide=true;
    const result=await f.reconcile(r);assert.equal(result.report.received,false);assert.equal(result.state,'broadcast-unknown');
    await assert.rejects(f.prepare({requestKey:'next'}),/ACCOUNT_UNRESOLVED_TRANSFER/);
  });
  test(`${family}: state disagreement never becomes a received observation`,async t=>{
    const f=await setup(t,family),{record:r}=await f.approve(await f.prepare(),true);await f.reconcile(r);
    f.state.mutate=(v,c)=>{if(c.peer===1&&c.path.startsWith('/transactions/')&&!c.path.endsWith('/operations'))v.hash='0'.repeat(64);return v;};
    const result=await f.reconcile(r);assert.equal(result.report.received,false);assert.equal(result.state,'broadcast-unknown');
  });
  test(`${family}: state changes to sequence reject old review before signature`,async t=>{
    const f=await setup(t,family),p=await f.prepare();f.state.sequence='8';await assert.rejects(f.approve(p,true),/ACCOUNT_SEQUENCE_CHANGED/);
    assert.equal((await f.vault.nonEvmRecords()).length,0);assert.equal(f.state.sent,0);
  });
  test(`${family}: insufficient amount plus reserve/gas is refused`,async t=>{
    const f=await setup(t,family);f.state.sourceBalance=1n;await assert.rejects(f.prepare(),/BALANCE/);assert.equal(f.state.sent,0);
  });
  test(`${family}: checkpoint mismatch fails before creating an approval`,async t=>{
    const f=await setup(t,family);f.state.mutate=(v,c)=>{if(c.path==='/ledgers/1')v.hash='33'.repeat(32);if(c.path==='/blocks/by_height/1')v.block_hash='0x'+'33'.repeat(32);return v;};
    await assert.rejects(f.prepare(),/CHECKPOINT_MISMATCH/);
  });
  test(`${family}: recipient confirmation cannot be substituted`,async t=>{
    const f=await setup(t,family),p=await f.prepare();await assert.rejects(f.call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:f.account.address,broadcast:true}),/TRANSACTION_CONFIRMATION_MISMATCH/);assert.equal(f.state.sent,0);
  });
  test(`${family}: lock while rechecking invalidates approval before signature`,async t=>{
    const f=await setup(t,family),p=await f.prepare();let release,waiting=false;const hold=new Promise(r=>release=r);
    f.state.delay=async()=>{waiting=true;await hold;};
    const result=f.approve(p,true).then(()=>null,e=>e);await waitFor(()=>waiting);await f.call('lock');f.state.delay=null;release();
    assert.ok(await result instanceof Error);await f.call('unlock',{password:PASSWORD});assert.equal((await f.vault.nonEvmRecords()).length,0);assert.equal(f.state.sent,0);
  });
  test(`${family}: signature save error never invokes submission`,async t=>{
    const f=await setup(t,family),p=await f.prepare();const saved=f.store.store.write;f.store.store.write=()=>{throw Error('TEST_DISK_FAILURE');};
    try{await assert.rejects(f.approve(p,true));assert.equal(f.state.sent,0);assert.equal(f.vault.status().locked,true);}finally{f.store.store.write=saved;}
  });
  test(`${family}: signed journal reload preserves network and sequence reservations`,async t=>{
    const f=await setup(t,family),{record:r}=await f.approve(await f.prepare());await f.call('lock');await f.call('unlock',{password:PASSWORD});
    assert.deepEqual((await f.vault.nonEvmRecords())[0],r);await assert.rejects(f.prepare({requestKey:'another'}),/ACCOUNT_UNRESOLVED_TRANSFER/);
  });
  test(`${family}: broadcast is rejected when disabled without producing a signature`,async t=>{
    const f=await setup(t,family);f.app.settings.accountNetworks=[{...f.network,broadcastEnabled:false}];const p=await f.prepare();
    await assert.rejects(f.approve(p,true),/BROADCAST_DISABLED/);assert.equal((await f.vault.nonEvmRecords()).length,0);
  });
  test(`${family}: amount/fee caps and precise decimal boundary are enforced`,async t=>{
    const f=await setup(t,family);for(const amount of ['1e2','-1','0.000000001',0.1])await assert.rejects(f.prepare({amountAtomic:undefined,amount}),/ACCOUNT_AMOUNT_PRECISION|ACCOUNT_AMOUNT_AMBIGUOUS/);
    await assert.rejects(f.prepare({amountAtomic:'1000000001'}),/ACCOUNT_POLICY_EXCEEDED/);
    const p=await f.prepare({...(family==='stellar'?{feeAtomic:'1000001'}:{maxGasAmount:'20000',gasUnitPrice:'100'})}).then(()=>null,e=>e);assert.ok(p instanceof Error);
  });
  test(`${family}: signed record summary cannot lie about the recipient or amount`,async t=>{
    const f=await setup(t,family),{record:r}=await f.approve(await f.prepare());
    for(const key of ['recipient','amountAtomic']){const bad=structuredClone(r);bad.summary[key]=key==='recipient'?f.account.address:'2';assert.throws(()=>validateNonEvmRecord(bad,[f.account]));}
  });
  test(`${family}: stale ledger refuses prepare`,async t=>{
    const f=await setup(t,family);f.state.mutate=(v,c)=>{if(c.path.startsWith('/ledgers/'))v.closed_at='2000-01-01T00:00:00Z';if(c.path==='/')v.ledger_timestamp='1';return v;};
    await assert.rejects(f.prepare(),/LEDGER_STALE/);
  });
  test(`${family}: RPC transport errors are sanitized and do not leak payloads`,async t=>{
    const f=await setup(t,family),rest=new AccountRest({fetchImpl:async()=>{throw Error('SECRET_API_KEY');}});
    await assert.rejects(rest.call(f.network,0,''),/^Error: ACCOUNT_RPC_TRANSPORT_UNCERTAIN$/);
  });
  test(`${family}: public hosts, auth URL, paths, duplicate endpoints and mainnet are rejected`,async t=>{
    const f=await setup(t,family);
    for(const url of ['https://example.com/','http://localhost:8000/','http://user:password@127.0.0.1:8000/','http://127.0.0.1:8000/?key=secret'])assert.throws(()=>validateAccountNetwork({...f.network,rpcUrls:[url,f.network.rpcUrls[1]]}));
    assert.throws(()=>validateAccountNetwork({...f.network,rpcUrls:[f.network.rpcUrls[0],f.network.rpcUrls[0]]}));
    assert.throws(()=>validateAccountNetwork({...f.network,id:'mainnet'}));
    const rest=new AccountRest();await assert.rejects(rest.call(f.network,0,'../wallet'));
  });
  test(`${family}: owner authorization required; AI and bridged app cannot call online APIs`,async t=>{
    const f=await setup(t,family);
    for(const headers of [{authorization:''},{origin:'https://hostile.example'}])assert.ok((await f.request('non-evm/account-online/balance',{accountId:f.account.id,networkId:f.network.id},headers)).status>=400);
    assert.ok((await fetch(f.started.origin+'/agent/v1/account-online/prepare',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status>=400);assert.equal(f.state.sent,0);
  });
}
test('Stellar reserve uses subentries, sponsoring, sponsored and selling liabilities',async t=>{
  const f=await setup(t,'stellar');f.state.sourceBalance=15000000n;f.state.subentries=1;await assert.rejects(f.prepare(),/STELLAR_BALANCE_OR_RESERVE/);
  f.state.sponsored=1;const p=await f.prepare();assert.equal(p.summary.amountAtomic,'1000000');f.state.liability='0.5';await assert.rejects(f.prepare(),/STELLAR_BALANCE_OR_RESERVE/);
});
test('Stellar memo-required and disabled master signer are not ignored',async t=>{
  const f=await setup(t,'stellar');f.state.memoRequired=true;await assert.rejects(f.prepare(),/STELLAR_DESTINATION_MEMO_REQUIRED/);await f.prepare({memo:'invoice-7'});f.state.masterWeight=0;await assert.rejects(f.prepare({memo:'invoice-7'}),/MASTER_SIGNATURE/);
});
test('Stellar successful claim with wrong operation or result XDR is retracted',async t=>{
  const f=await setup(t,'stellar'),{record:r}=await f.approve(await f.prepare(),true);
  f.state.mutate=(v,c)=>{if(c.path.endsWith('/operations'))v._embedded.records[0].amount='99';return v;};
  assert.equal((await f.reconcile(r)).report.received,false);
  f.state.mutate=(v,c)=>{if(c.path.startsWith('/transactions/')&&!c.path.endsWith('/operations'))v.result_xdr=Buffer.alloc(32).toString('base64');return v;};
  assert.equal((await f.reconcile(r)).report.received,false);
});
test('Aptos key rotation rejects old private key',async t=>{
  const f=await setup(t,'aptos');f.state.authKey=f.to;await assert.rejects(f.prepare(),/ROTATED_AUTH_KEY/);assert.equal(f.state.simulations,0);
});
test('Aptos simulation uses zero signature; altered payload or failed VM blocks signing',async t=>{
  const f=await setup(t,'aptos');const p=await f.prepare();assert.ok(f.state.simulations>0);assert.equal(f.state.signaturesVerified,0);
  f.state.mutate=(v,c)=>{if(c.path==='/transactions/simulate')v[0].payload.arguments[1]='2';return v;};
  await assert.rejects(f.approve(p,true),/APTOS_PAYLOAD_MISMATCH/);assert.equal(f.state.sent,0);
});
test('Aptos transaction with altered historical balance deltas is not received',async t=>{
  const f=await setup(t,'aptos'),{record:r}=await f.approve(await f.prepare(),true);
  f.state.mutate=(v,c)=>{if(c.path==='/view')return ['1'];return v;};
  assert.equal((await f.reconcile(r)).report.received,false);
});
test('Aptos pending response is not a committed or received transaction',async t=>{
  const f=await setup(t,'aptos'),{record:r}=await f.approve(await f.prepare(),true);f.state.pending=true;
  const result=await f.reconcile(r);assert.equal(result.report.received,false);assert.equal(result.state,'broadcast-unknown');
});
test('Account native decimal conversion is exact, bounded and non-floating',()=>{
  assert.equal(decimalAtomic('123.1234567',7),'1231234567');assert.equal(decimalAtomic('0.00000001',8),'1');
  for(const x of ['1e8','NaN','-2','0.000000001'])assert.throws(()=>decimalAtomic(x,8));
});

for(const family of ['stellar','aptos']){
  test(`${family}: checkpoint JSON registration locks before saving and never auto-sends`,async t=>{
    const f=await setup(t,family);f.app.settings.accountNetworks=[];let wasLocked=false;
    f.app.saveSettings=()=>{wasLocked=f.vault.status().locked;};
    await assert.rejects(f.call('non-evm/account-online/networks/add',{network:f.network,confirmation:'bad'}),/ACCOUNT_NETWORK_CONFIRMATION_REQUIRED/);
    await f.call('non-evm/account-online/networks/add',{network:f.network,confirmation:`ADD ${f.network.id} ${f.network.checkpoint.hash}`});
    assert.equal(wasLocked,true);assert.equal(f.vault.status().locked,true);assert.equal(f.state.sent,0);
  });
  test(`${family}: failed settings save keeps lock and restart barrier`,async t=>{
    const f=await setup(t,family);f.app.settings.accountNetworks=[];
    f.app.saveSettings=()=>{throw Error('TEST_SETTINGS_FAILURE');};
    await assert.rejects(f.call('non-evm/account-online/networks/add',{network:f.network,confirmation:`ADD ${f.network.id} ${f.network.checkpoint.hash}`}),/TEST_SETTINGS_FAILURE/);
    assert.equal(f.vault.status().locked,true);await f.call('unlock',{password:PASSWORD});
    await assert.rejects(f.call('non-evm/history'),/NON_EVM_SETTINGS_RESTART_REQUIRED/);
  });
  test(`${family}: lock after remote acceptance cannot install a late success`,async t=>{
    const f=await setup(t,family),p=await f.prepare();const original=f.app.nonEvm.accountEngine.adapter(f.network).submit;
    let release,waiting=false;const hold=new Promise(r=>release=r);
    f.app.nonEvm.accountEngine.adapter(f.network).submit=async function(n,r){await original.call(this,n,r);waiting=true;await hold;};
    const outcome=f.approve(p,true).then(()=>null,e=>e);await waitFor(()=>waiting);await f.call('lock');await f.call('unlock',{password:PASSWORD});release();
    assert.ok(await outcome instanceof Error);assert.equal(f.state.sent,1);
    const records=await f.vault.nonEvmRecords();assert.equal(records[0].state,'broadcast-unknown');assert.equal((await f.reconcile(records[0])).report.received,true);
  });
  test(`${family}: transaction execution failure consumes sequence but does not claim receipt`,async t=>{
    const f=await setup(t,family),{record:r}=await f.approve(await f.prepare());
    if(family==='aptos'){
      const adapter=f.app.nonEvm.accountEngine.adapter(f.network),submit=adapter.submit;
      adapter.submit=async function(n,r){f.state.failed=true;return submit.call(this,n,r);};
    }else f.state.failed=true;
    const sent=await f.call('non-evm/account-online/submit',{id:r.id,confirmation:r.signed.requestId});
    const result=await f.reconcile(sent);assert.equal(result.state,'reported-reverted');assert.equal(result.report.received,false);assert.equal(f.state.toBalance,2000000000n);
  });
  test(`${family}: a changed network fingerprint cannot send an old signature`,async t=>{
    const f=await setup(t,family),{record:r}=await f.approve(await f.prepare());
    f.app.settings.accountNetworks=[{...f.network,maxFeeAtomic:'999999'}];
    await assert.rejects(f.call('non-evm/account-online/submit',{id:r.id,confirmation:r.signed.requestId}),/ACCOUNT_RECORD_NETWORK_CHANGED/);assert.equal(f.state.sent,0);
  });
  test(`${family}: chain transaction expiration blocks first send, retaining signature`,async t=>{
    const f=await setup(t,family),{record:r}=await f.approve(await f.prepare());f.now.value+=181000;
    await assert.rejects(f.call('non-evm/account-online/submit',{id:r.id,confirmation:r.signed.requestId}),/ACCOUNT_TRANSACTION_EXPIRED/);
    assert.equal((await f.vault.nonEvmRecords())[0].state,'signed');assert.equal(f.state.sent,0);
  });
  test(`${family}: post-submit persistence error leaves durable unknown record`,async t=>{
    const f=await setup(t,family),p=await f.prepare(),store=f.store.store,original=store.write;let writes=0;
    store.write=function(...args){writes++;if(writes===3)throw Error('TEST_OBSERVATION_WRITE_FAILURE');return original.apply(this,args);};
    await assert.rejects(f.approve(p,true));assert.equal(f.state.sent,1);assert.equal(f.vault.status().locked,true);store.write=original;
    await f.call('unlock',{password:PASSWORD});const records=await f.vault.nonEvmRecords();assert.equal(records[0].state,'broadcast-unknown');assert.equal((await f.reconcile(records[0])).report.received,true);
  });
  test(`${family}: simultaneous approvals serialize the sequence reservation`,async t=>{
    const f=await setup(t,family),p=await f.prepare(),q=await f.prepare({requestKey:'other'});
    const outcomes=await Promise.allSettled([f.approve(p),f.approve(q)]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal((await f.vault.nonEvmRecords()).length,1);assert.equal(f.state.sent,0);
  });
}
