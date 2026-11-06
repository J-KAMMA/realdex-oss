/** Real SPL Token VM execution. RPC identity/finality are synthetic; no cluster/consensus claims. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {WalletServer} from '../../wallet/lib/server.mjs';
import {Vault} from '../../wallet/lib/vault.mjs';
import {base58Encode} from '../../wallet/lib/keys.mjs';
import {storeFixture,PASSWORD} from '../../wallet/test/fixtures.mjs';
import {SOL_SEED,SOL_TO} from '../../wallet/test/non-evm-fixtures.mjs';
import {validateSolanaNetwork} from '../../wallet/non-evm/solana-network.mjs';
const key=n=>base58Encode(Buffer.alloc(32,n)),mint=key(70),source=key(71),destination=key(72);
let child,base,genesis,stderr='';
before(async()=>{
  assert.ok(process.env.REALDEX_SOLANA_TEST_ARCHIVE,'REALDEX_SOLANA_TEST_ARCHIVE_REQUIRED');
  child=spawn('python3',['-I',fileURLToPath(new URL('./pinned_runtime.py',import.meta.url)),'--archive',process.env.REALDEX_SOLANA_TEST_ARCHIVE],{stdio:['ignore','pipe','pipe']});child.stderr.on('data',b=>stderr+=b);
  const h=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('LITESVM_START_TIMEOUT')),20000);const l=createInterface({input:child.stdout});l.once('line',s=>{clearTimeout(timer);try{resolve(JSON.parse(s));}catch(e){reject(e);}});child.once('exit',()=>{clearTimeout(timer);reject(Error(stderr));});child.once('error',reject);});
  assert.equal(h.kind,'LiteSVM-with-synthetic-RPC-metadata');base=`http://127.0.0.1:${h.port}`;genesis=h.genesisHash;
});
after(async()=>{if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}});
async function rpc(method,params=[]){const r=await fetch(base+'/one',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});const b=await r.json();if(b.error)throw Error(b.error.message);return b.result;}
async function fixture(t,{sourceAmount='1000000000',destinationAmount='1000000'}={}){
  await rpc('test_reset');const f=storeFixture(),vault=new Vault(f.store);await vault.create(PASSWORD);
  const a=await vault.addAccount({family:'solana',secretHex:SOL_SEED,label:'Public SPL fixture seed'});const b=await vault.backup();await vault.verifyBackup(b.encrypted,PASSWORD);
  await rpc('test_fund',[a.address,1000000000]);await rpc('test_spl_setup',[{from:a.address,to:SOL_TO,mint,source,destination,decimals:6,sourceAmount,destinationAmount}]);
  const n=validateSolanaNetwork({family:'solana',cluster:'localnet',id:'solana-local:spl-test',name:'SPL LiteSVM only',genesisHash:genesis,rpcUrls:[base+'/one',base+'/two'],broadcastEnabled:true,maxFeeLamports:'10000',maxTransferLamports:'1000000000',splTokens:[{mint,symbol:'TEST',decimals:6,maxTransferAtomic:'18446744073709551615'}]});
  const server=new WalletServer({store:f.store,vault,settings:{schema:'realdex.wallet-settings.v1',allowedAppOrigins:[],networks:[],solanaNetworks:[n]}});const started=await server.start(0);
  t.after(async()=>{await server.close();f.close();});
  const call=async(route,b={})=>{const r=await fetch(started.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json',origin:started.origin,authorization:'Bearer '+server.uiToken},body:JSON.stringify(b)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
  const prepare=(patch={})=>call('non-evm/spl/prepare',{accountId:a.id,networkId:n.id,payment:{requestKey:'spl-1',mint,source,destination,to:SOL_TO,amount:'1.25',...patch}});
  const approve=(p,broadcast=true)=>call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:SOL_TO,broadcast});
  return {vault,a,n,server,call,prepare,approve};
}
test('SPL LiteSVM: preparation and owner account discovery do not sign or move tokens',async t=>{const f=await fixture(t),p=await f.prepare();assert.equal(p.summary.amountAtomic,'1250000');assert.equal(p.summary.feeAtomic,'5000');assert.equal((await rpc('test_info')).sent,0);const r=await f.call('non-evm/spl/accounts',{networkId:f.n.id,owner:f.a.address,mint});assert.equal(r.accounts[0].address,source);assert.equal(r.accounts[0].amountAtomic,'1000000000');assert.deepEqual((await f.call('non-evm/history')).records,[]);});
test('SPL LiteSVM: owner HTTP signing executes TransferChecked and validates exact token/native deltas',async t=>{const f=await fixture(t),r=await f.approve(await f.prepare());assert.equal(r.record.state,'broadcast');assert.equal((await rpc('test_info')).sent,1);const settled=await f.call('non-evm/solana/reconcile',{id:r.record.id});assert.equal(settled.state,'reported-finalized');assert.equal(settled.report.received,true);assert.deepEqual(settled.report.postTokenAtomic,['998750000','2250000']);assert.equal((await rpc('getBalance',[f.a.address])).value,999995000);});
test('SPL LiteSVM: uint64 token balances above 2^53 are exact',async t=>{const f=await fixture(t,{sourceAmount:'9007199254740993',destinationAmount:'0'}),p=await f.prepare({amount:'9007199254.740993'});assert.equal(p.summary.amountAtomic,'9007199254740993');const r=await f.approve(p),v=await f.call('non-evm/solana/reconcile',{id:r.record.id});assert.deepEqual(v.report.postTokenAtomic,['0','9007199254740993']);});
test('SPL LiteSVM: reject unknown mint, over-precision, zero and self transfer before signing',async t=>{const f=await fixture(t);for(const [p,error]of [[{mint:key(75)},/SPL_MINT_NOT_REGISTERED/],[{amount:'1.0000001'},/SPL_AMOUNT_PRECISION/],[{amount:'0'},/SPL_AMOUNT_ZERO/],[{to:f.a.address},/SPL_ACCOUNT_ALIAS/]])await assert.rejects(f.prepare(p),error);assert.equal((await rpc('test_info')).sent,0);});
for(const [name,target,mutation,error]of [
  ['frozen source',source,{state:2},/SPL_ACCOUNT_FROZEN/],
  ['wrong recipient owner',destination,{owner:key(77)},/SPL_MINT_OR_AUTHORITY/],
  ['wrong destination mint',destination,{mint:key(78)},/SPL_MINT_OR_AUTHORITY/],
  ['delegated source',source,{delegate:key(78)},/SPL_EXTERNAL_AUTHORITY/],
  ['extension layout',source,{extra:8},/SPL_EXTENSIONS_OR_LAYOUT/],
  ['wrong token program',source,{program:key(78)},/SPL_PROGRAM_OWNER/],
  ['insufficient token balance',source,{amount:'1'},/INSUFFICIENT_SPL_BALANCE/],
])test('SPL LiteSVM: refuse '+name,async t=>{const f=await fixture(t);await rpc('test_spl_mutate',[target,mutation]);await assert.rejects(f.prepare(),error);assert.equal((await rpc('test_info')).sent,0);});
test('SPL LiteSVM: changed decimals and freeze authority invalidate an already reviewed request',async t=>{const f=await fixture(t),p=await f.prepare();await rpc('test_spl_mutate',[mint,{decimals:7}]);await assert.rejects(f.approve(p),/SPL_DECIMALS_CHANGED/);await rpc('test_spl_mutate',[mint,{decimals:6}]);const q=await f.prepare();await rpc('test_spl_mutate',[mint,{freezeAuthority:key(77)}]);await assert.rejects(f.approve(q),/SPL_REVIEW_STATE_CHANGED/);assert.equal((await f.call('non-evm/history')).records.length,0);});
test('SPL LiteSVM: lost response and identical retry do not double-transfer',async t=>{const f=await fixture(t),p=await f.prepare();await rpc('test_control',[{drop:true}]);const r=await f.approve(p);assert.equal(r.record.state,'broadcast-unknown');assert.equal((await f.prepare()).alreadyRecorded,true);assert.equal((await rpc('test_info')).sent,1);const v=await f.call('non-evm/solana/reconcile',{id:r.record.id});assert.equal(v.report.received,true);});
test('SPL LiteSVM: signed-only first submission revalidates destination ownership',async t=>{const f=await fixture(t),r=await f.approve(await f.prepare(),false);await rpc('test_spl_mutate',[destination,{owner:key(77)}]);await assert.rejects(f.call('non-evm/solana/submit',{id:r.record.id,confirmation:r.record.signed.signature}),/SPL_MINT_OR_AUTHORITY/);assert.equal((await rpc('test_info')).sent,0);});
test('SPL LiteSVM: missing token receipt retracts success and remains unresolved',async t=>{const f=await fixture(t),r=await f.approve(await f.prepare());await f.call('non-evm/solana/reconcile',{id:r.record.id});await rpc('test_control',[{omitTokens:true}]);const v=await f.call('non-evm/solana/reconcile',{id:r.record.id});assert.equal(v.report.received,false);assert.equal(v.state,'broadcast-unknown');assert.match(v.report.reason,/SPL_TOKEN_RECEIPT_REQUIRED/);});
test('SPL LiteSVM: restored encrypted record retains exact signature and owner/token binding',async t=>{const f=await fixture(t),r=await f.approve(await f.prepare(),false),b=await f.vault.backup();const x=storeFixture(),v=new Vault(x.store);t.after(()=>{v.lock();x.close();});await v.restore(b.encrypted,PASSWORD);await v.unlock(PASSWORD);assert.deepEqual((await v.nonEvmRecords())[0],r.record);});
