/** Real LiteSVM execution behind synthetic RPC metadata; no validator/consensus assertion. */
import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {WalletServer} from '../../wallet/lib/server.mjs';
import {Vault} from '../../wallet/lib/vault.mjs';
import {storeFixture,PASSWORD} from '../../wallet/test/fixtures.mjs';
import {SOL_SEED,SOL_TO} from '../../wallet/test/non-evm-fixtures.mjs';
import {validateSolanaNetwork} from '../../wallet/non-evm/solana-network.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
let child,base,genesis,stderr='';
before(async()=>{
  assert.ok(process.env.REALDEX_SOLANA_TEST_ARCHIVE,'REALDEX_SOLANA_TEST_ARCHIVE_REQUIRED; no mock fallback');
  child=spawn(process.env.REALDEX_TEST_PYTHON||'python3',['-I',path.join(HERE,'pinned_runtime.py'),'--archive',path.resolve(process.env.REALDEX_SOLANA_TEST_ARCHIVE)],{stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',b=>{stderr+=b.toString();});
  const header=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('LITESVM_START_TIMEOUT')),20000);
    const lines=createInterface({input:child.stdout});
    lines.once('line',l=>{clearTimeout(timer);try{resolve(JSON.parse(l));}catch(e){reject(e);}});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('LITESVM_EXIT: '+stderr));});
  });
  assert.equal(header.kind,'LiteSVM-with-synthetic-RPC-metadata');base=`http://127.0.0.1:${header.port}`;genesis=header.genesisHash;
});
after(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}});
async function rpc(method,params=[]){const r=await fetch(base+'/one',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});const b=await r.json();if(b.error)throw Error('TEST_RPC_'+b.error.message);return b.result;}
async function fixture(t){
  await rpc('test_reset');const f=storeFixture(),clock={value:Date.now()},vault=new Vault(f.store,{now:()=>clock.value});await vault.create(PASSWORD);
  const account=await vault.addAccount({family:'solana',secretHex:SOL_SEED,label:'Public LiteSVM test seed'});
  const backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
  await rpc('test_fund',[account.address,1000000000]);await rpc('test_fund',[SOL_TO,1000000]);
  const network=validateSolanaNetwork({family:'solana',cluster:'localnet',id:'solana-local:litesvm',name:'TEST ONLY LiteSVM',genesisHash:genesis,rpcUrls:[base+'/one',base+'/two'],broadcastEnabled:true,maxFeeLamports:'10000',maxTransferLamports:'1000000000'});
  const server=new WalletServer({store:f.store,vault,now:()=>clock.value,settings:{schema:'realdex.wallet-settings.v1',networks:[],solanaNetworks:[network],allowedAppOrigins:[]}});const started=await server.start(0);
  t.after(async()=>{await server.close();f.close();});
  const call=async(route,b={})=>{const r=await fetch(started.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json',origin:started.origin,authorization:'Bearer '+server.uiToken},body:JSON.stringify(b)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
  const prepare=(payment={})=>call('non-evm/solana/prepare',{accountId:account.id,networkId:network.id,payment:{requestKey:'payment-1',to:SOL_TO,amount:'0.001',...payment}});
  const approve=(p,broadcast=true)=>call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:SOL_TO,broadcast});
  return {...f,vault,account,network,server,clock,call,prepare,approve,started};
}
test('LiteSVM: preparation simulates without signing or changing balances',async t=>{const f=await fixture(t),p=await f.prepare();assert.equal(p.summary.amountAtomic,'1000000');assert.equal(p.summary.feeAtomic,'5000');assert.equal((await rpc('getBalance',[f.account.address])).value,1000000000);assert.equal((await rpc('getBalance',[SOL_TO])).value,1000000);assert.equal((await f.call('non-evm/history')).records.length,0);assert.equal((await rpc('test_info')).sent,0);});
test('LiteSVM: owner HTTP approval executes signature and exact native balance/fee deltas',async t=>{const f=await fixture(t),p=await f.prepare(),a=await f.approve(p);assert.equal(a.record.state,'broadcast');assert.equal((await rpc('test_info')).sent,1);assert.equal((await rpc('getBalance',[f.account.address])).value,998995000);assert.equal((await rpc('getBalance',[SOL_TO])).value,2000000);const r=await f.call('non-evm/solana/reconcile',{id:a.record.id});assert.equal(r.state,'reported-finalized');assert.equal(r.report.feeAtomic,'5000');assert.equal(r.report.received,true);assert.match(r.report.assurance,/no light-client/);});
test('LiteSVM: repeated request key returns stored result without another signature or debit',async t=>{const f=await fixture(t),p=await f.prepare(),a=await f.approve(p);const again=await f.prepare();assert.equal(again.record.id,a.record.id);assert.equal(again.alreadyRecorded,true);assert.equal(again.submittedAgain,false);assert.equal((await rpc('test_info')).sent,1);assert.equal((await rpc('getBalance',[SOL_TO])).value,2000000);await assert.rejects(f.prepare({amount:'0.002'}),/PAYMENT_KEY_CONTENT_CONFLICT/);});
test('LiteSVM: lost HTTP response after execution remains unknown and is resolved without resending',async t=>{const f=await fixture(t),p=await f.prepare();await rpc('test_control',[{drop:true}]);const a=await f.approve(p);assert.equal(a.record.state,'broadcast-unknown');assert.equal((await rpc('test_info')).sent,1);assert.equal((await rpc('getBalance',[SOL_TO])).value,2000000);const r=await f.call('non-evm/solana/reconcile',{id:a.record.id});assert.equal(r.report.received,true);await f.prepare();assert.equal((await rpc('test_info')).sent,1);});
test('LiteSVM: status below fixture finality does not show received',async t=>{const f=await fixture(t),a=await f.approve(await f.prepare());await rpc('test_control',[{commitment:'confirmed'}]);const r=await f.call('non-evm/solana/reconcile',{id:a.record.id});assert.equal(r.report.received,false);assert.equal(r.report.reason,'not-finalized');});
test('LiteSVM: disappearing observation retracts success but retains signed bytes and blocks replacement',async t=>{const f=await fixture(t),a=await f.approve(await f.prepare());await f.call('non-evm/solana/reconcile',{id:a.record.id});await rpc('test_control',[{hide:true}]);const r=await f.call('non-evm/solana/reconcile',{id:a.record.id});assert.equal(r.state,'broadcast-unknown');assert.equal(r.report.received,false);assert.equal(r.signed.transactionBase64,a.record.signed.transactionBase64);const next=await f.prepare({requestKey:'payment-2'});await assert.rejects(f.approve(next),/SOLANA_UNRESOLVED_TRANSFER/);assert.equal((await rpc('test_info')).sent,1);});
test('LiteSVM: expired blockhash cancels approval without generating a fresh signed transaction',async t=>{const f=await fixture(t),p=await f.prepare();await rpc('test_expire');await assert.rejects(f.approve(p),/SOLANA_BLOCKHASH/);assert.equal((await f.call('non-evm/history')).records.length,0);assert.equal((await rpc('test_info')).sent,0);});
test('LiteSVM: changed balance at approval fails closed before signature',async t=>{const f=await fixture(t),p=await f.prepare();await rpc('test_fund',[f.account.address,5000]);await assert.rejects(f.approve(p),/INSUFFICIENT_SOL_BALANCE/);assert.equal((await f.call('non-evm/history')).records.length,0);});
test('LiteSVM: signer does not accept disagreeing network identity',async t=>{const f=await fixture(t);await rpc('test_control',[{mismatch:true}]);await assert.rejects(f.prepare(),/SOLANA_GENESIS_MISMATCH/);assert.equal((await rpc('test_info')).sent,0);});
test('LiteSVM: explicit sign-only requires a second signature-ID confirmation to submit',async t=>{const f=await fixture(t),a=await f.approve(await f.prepare(),false);assert.equal(a.record.state,'signed');assert.equal((await rpc('test_info')).sent,0);await assert.rejects(f.call('non-evm/solana/submit',{id:a.record.id,confirmation:'wrong'}),/SOLANA_SIGNATURE_CONFIRMATION_REQUIRED/);const r=await f.call('non-evm/solana/submit',{id:a.record.id,confirmation:a.record.signed.signature});assert.equal(r.state,'broadcast');assert.equal((await rpc('test_info')).sent,1);await assert.rejects(f.call('non-evm/solana/submit',{id:r.id,confirmation:r.signed.signature}),/SOLANA_AUTOMATIC_REBROADCAST_FORBIDDEN/);});
test('LiteSVM: saved signed transaction rechecks the fee before first submission',async t=>{const f=await fixture(t),a=await f.approve(await f.prepare(),false);await rpc('test_control',[{fee:6000}]);await assert.rejects(f.call('non-evm/solana/submit',{id:a.record.id,confirmation:a.record.signed.signature}),/SOLANA_FEE_CHANGED/);assert.equal((await rpc('test_info')).sent,0);assert.equal((await f.call('non-evm/history')).records[0].state,'signed');});
test('LiteSVM: lock revokes pending request, while durable record survives re-unlock',async t=>{const f=await fixture(t),a=await f.approve(await f.prepare(),false);await f.call('lock');await assert.rejects(f.call('non-evm/history'),/VAULT_LOCKED/);await f.call('unlock',{password:PASSWORD});const h=await f.call('non-evm/history');assert.equal(h.records[0].signed.signature,a.record.signed.signature);assert.equal((await rpc('test_info')).sent,0);});
test('LiteSVM: signed record survives encrypted backup restoration',async t=>{const f=await fixture(t),a=await f.approve(await f.prepare());const backup=await f.vault.backup();const other=storeFixture(),v=new Vault(other.store);t.after(()=>{v.lock();other.close();});await v.restore(backup.encrypted,PASSWORD);await v.unlock(PASSWORD);const records=await v.nonEvmRecords();assert.equal(records.length,1);assert.equal(records[0].signed.signature,a.record.signed.signature);assert.equal(records[0].state,'broadcast');assert.equal((await rpc('test_info')).sent,1);});
test('LiteSVM: unrelated bearer token cannot use owner-only non-EVM methods',async t=>{const f=await fixture(t);const r=await fetch(f.started.origin+'/api/non-evm/solana/prepare',{method:'POST',headers:{origin:f.started.origin,'content-type':'application/json',authorization:'Bearer '+'11'.repeat(32)},body:'{}'});assert.equal(r.status,401);assert.equal((await rpc('test_info')).sent,0);});
