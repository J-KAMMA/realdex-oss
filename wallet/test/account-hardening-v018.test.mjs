/** Negative fixtures are deliberate; they never contact a real chain. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountRest} from '../non-evm/account-network.mjs';
import {AptosAdapter} from '../non-evm/aptos-online.mjs';
import {accountOnlineFixture} from './account-online-fixtures.mjs';
const n={family:'stellar',id:'stellar:standalone',name:'Transport test',rpcUrls:['http://127.0.0.1:8001/','http://127.0.0.1:8002/'],checkpoint:{height:1,hash:'11'.repeat(32)},broadcastEnabled:false,maxTransferAtomic:'1000000',maxFeeAtomic:'10000',minConfirmations:1,networkPassphrase:'Standalone Network ; February 2017'};
for(const [label,bytes] of [
 ['duplicate result',Buffer.from('{"successful":false,"successful":true}')],
 ['escaped duplicate',Buffer.from('{"ok":false,"\\u006fk":true}')],
 ['invalid UTF8',Buffer.from([123,34,97,34,58,34,0xff,34,125])],
 ['unsafe numeric integer',Buffer.from('{"height":9007199254740993}')],
 ['negative zero',Buffer.from('{"height":-0}')],
 ['noninteger numeric value',Buffer.from('{"height":1.5}')],
 ['fraction rounded to integer',Buffer.from('{"sequence":1.0000000000000001}')],
 ['exponent underflow rounded to zero',Buffer.from('{"balance":1e-9999}')],
 ['lone surrogate',Buffer.from('{"memo":"\\ud800"}')],
 ['prototype member',Buffer.from('{"__proto__":{}}')],
 ['excessive nesting',Buffer.from('['.repeat(34)+'0'+']'.repeat(34))],
]) test(`account transport rejects ${label}`,async()=>{
 const rest=new AccountRest({fetchImpl:async()=>new Response(bytes,{headers:{'content-type':'application/json'}})});
 await assert.rejects(rest.call(n,0,''),/ACCOUNT_RPC_JSON_INVALID/);
});
for(const endpoint of ['?admin=true','ledgers/1?cursor=1','transactions/'+'1'.repeat(64)+'?limit=100', 'transactions/'+'1'.repeat(64)+'/operations?limit=2&limit=50&include_failed=true'])
 test(`account transport rejects unsupported query: ${endpoint}`,async()=>{
  let calls=0;const rest=new AccountRest({fetchImpl:async()=>{calls++;return new Response('{}',{headers:{'content-type':'application/json'}});}});
  await assert.rejects(rest.call(n,0,endpoint));assert.equal(calls,0);
 });
for(const variant of ['missing-chain','wrong-chain','behind-version']) test(`Aptos response header check: ${variant}`,async()=>{
 const {networkPassphrase,...other}=n;const network={...other,family:'aptos',id:'aptos:local-4',chainId:4,rpcUrls:['http://127.0.0.1:8001/v1/','http://127.0.0.1:8002/v1/'],checkpoint:{height:1,hash:'0x'+'11'.repeat(32)}};
 const headers={'content-type':'application/json','x-aptos-chain-id':'4','x-aptos-ledger-version':'100','x-aptos-ledger-oldest-version':'0'};
 if(variant==='missing-chain')delete headers['x-aptos-chain-id'];
 if(variant==='wrong-chain')headers['x-aptos-chain-id']='1';
 if(variant==='behind-version')headers['x-aptos-ledger-version']='99';
 const rest=new AccountRest({fetchImpl:async()=>new Response('{}',{headers})});
 await assert.rejects(rest.call(network,0,'accounts/0x'+'1'.repeat(64)+'?ledger_version=100'));
});
test('Stellar malformed failed result cannot finalize an unresolved payment',async t=>{
 const f=await accountOnlineFixture('stellar');t.after(()=>f.close());const {record}=await f.approve(await f.prepare(),true);
 f.state.mutate=(v,c)=>{if(c.path.startsWith('/transactions/')&&!c.path.endsWith('/operations')){
  v.successful=false;const b=Buffer.alloc(16);b.writeBigUInt64BE(100n);b.writeInt32BE(-12345,8);v.result_xdr=b.toString('base64');
 }return v;};
 const r=await f.reconcile(record);assert.notEqual(r.state,'reported-reverted');assert.equal(r.report.received,false);
});
test('Aptos contradictory success and vm_status is not accepted',async t=>{
 const f=await accountOnlineFixture('aptos');t.after(()=>f.close());const {record}=await f.approve(await f.prepare(),true);
 f.state.mutate=(v,c)=>{if(c.path.startsWith('/transactions/'))v.vm_status='Move abort';return v;};
 const r=await f.reconcile(record);assert.equal(r.report.received,false);assert.notEqual(r.state,'reported-confirmed');
});
test('Aptos block response rejects an inverted version interval',()=>{
 const adapter=new AptosAdapter({},Date.now);
 assert.throws(()=>adapter.block({block_height:'10',block_hash:'0x'+'22'.repeat(32),first_version:'100',last_version:'99',block_timestamp:'1788625500000000'}));
});
