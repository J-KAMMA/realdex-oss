import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';import {accountAddress} from '../../../wallet/codec/bech32.mjs';
import {preflightInjectiveLimitOrder as preflight,observeAndPreflightInjectiveOrder as pipeline} from '../injective-preflight.mjs';
import {demoSnapshot,DEMO_MARKET,demoInputs} from '../demo.mjs';
import {marketBytes,bookBytes,grpc} from './fixtures.mjs';
const PUBLIC='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const ADDRESS_HEX='7e5f4552091a69125d5dfcb7b8c2659029395bdf',sender=accountAddress('inj',Buffer.from(ADDRESS_HEX,'hex'));
const NOW=1788716400000,CHAIN='injective-888',BLOCK='11'.repeat(32),BPS=50;
function request(now=NOW){const snapshot=demoSnapshot('injective',now);snapshot.market.network=CHAIN;
 for(const a of ['base','quote'])snapshot.market[a].id=snapshot.market[a].id.replace('synthetic-demo',CHAIN);
 return {snapshot,input:{requestKey:'preflight-1',sender,subaccountId:'0x'+ADDRESS_HEX+'0'.repeat(24),side:'buy',quantity:'1.25',limitPrice:'11'},chainId:CHAIN,endpoint:'http://127.0.0.1:1',publicKeyHex:PUBLIC,
 policy:{gasLimit:'300000',gasPriceAtomic:'500000000',maxGasFeeAtomic:'150000000000000',maxTradingFeeBps:BPS,gasMarginBps:12500,timeoutBlocks:20,maxAgeMs:30000}};
}
function dataFor(url,r,now){
 if(url.includes('/blocks/'))return {block_id:{hash:BLOCK},block:{header:{chain_id:CHAIN,height:'100',time:new Date(now).toISOString()}}};
 if(url.includes('/accounts/'))return {account:{'@type':'/injective.types.v1beta1.EthAccount',base_account:{address:sender,pub_key:{'@type':'/injective.crypto.v1beta1.ethsecp256k1.PubKey',key:Buffer.from(PUBLIC,'hex').toString('base64')},account_number:'9007199254740993',sequence:'9007199254740995'}}};
 if(url.includes('/spot/markets/')){const m=demoInputs(now).market;return {market:{market_id:DEMO_MARKET,status:'Active',base_denom:r.snapshot.market.base.id.split('/bank:')[1],quote_denom:r.snapshot.market.quote.id.split('/bank:')[1],base_decimals:'18',quote_decimals:'6',min_price_tick_size:'1',min_quantity_tick_size:'0.01',min_notional:'0.000001',maker_fee_rate:'-0.001',taker_fee_rate:m.takerFeeRate}};}
 if(url.includes('/spendable_balances/'))return {balance:{denom:new URL(url,'http://127.0.0.1').searchParams.get('denom'),amount:'100000000000000000000'}};
 if(url.includes('/subaccountDeposit'))return {deposits:{available_balance:'100000000.999999999999999999',total_balance:'200000000.000000000000000000'}};
 if(url==='/cosmos/tx/v1beta1/simulate')return {gas_info:{gas_wanted:'300000',gas_used:'200000'},result:{data:'',log:'',events:[]}};
 throw Error('UNEXPECTED_PATH '+url);
}
function fake(r,{mutate,raw,headers,status=200,delay=false}={}){const calls=[];return {calls,fetchImpl:async(u,o)=>{
 calls.push({u,o});if(delay)return new Promise(()=>{});const url=new URL(u).pathname+new URL(u).search,d=dataFor(url,r,NOW);mutate?.(d,url,calls.length);
 return new Response(raw?.(d,url)??JSON.stringify(d),{status,headers:{'content-type':'application/json',...(o.headers['x-cosmos-block-height']?{'x-cosmos-block-height':o.headers['x-cosmos-block-height']}:{}),...headers}});
}};}
const execute=(r,f)=>preflight(r,{fetchImpl:f.fetchImpl,now:()=>NOW});
const safe=v=>{for(const k of ['ownerApproved','chainStateAuthenticated','signingEnabled','broadcastEnabled','executable','settlementVerified'])assert.equal(v[k],false,k);};
test('Full preflight binds exact account counters, costs and unsigned bytes without signer access',async()=>{
 const r=request(),f=fake(r),v=await execute(r,f);safe(v);assert.equal(v.account.sequence,'9007199254740995');assert.equal(v.account.accountNumber,'9007199254740993');
 assert.equal(v.spend.requiredAtomic,'13818750');assert.equal(v.costs.tradingFeeQuoteCapAtomic,'68750');assert.equal(v.transaction.timeoutHeight,'120');assert.deepEqual(v.transaction.signatures,[]);
 assert.equal(f.calls.filter(c=>c.o.method==='POST').length,1);assert.ok(f.calls.every(c=>c.o.method==='GET'||c.u.endsWith('/simulate')));
 assert.ok(f.calls.every(c=>c.o.credentials==='omit'&&c.o.redirect==='error'&&c.o.referrerPolicy==='no-referrer'));
 const {reviewSha256,...body}=v;assert.equal(createHash('sha256').update(JSON.stringify(body)).digest('hex'),reviewSha256);assert.ok(Object.isFrozen(v.account));
 const ref=spawnSync('python3',[new URL('./injective-preflight-reference.py',import.meta.url).pathname],{input:JSON.stringify(v),encoding:'utf8',timeout:10000});assert.equal(ref.status,0,ref.stderr);assert.equal(JSON.parse(ref.stdout).passed,true);
});
test('A nondefault subaccount uses available exchange funds, not total funds or bank funds',async()=>{const r=request();r.input.subaccountId=r.input.subaccountId.slice(0,-1)+'1';const f=fake(r),v=await execute(r,f);assert.equal(v.spend.location,'exchange-subaccount');assert.equal(v.spend.availableAtomic,'100000000');assert.equal(f.calls.filter(c=>c.u.includes('/subaccountDeposit')).length,1);});
test('Sell reserves exact base atoms and never treats quote trading fees as base tokens',async()=>{const r=request();r.input.side='sell';const v=await execute(r,fake(r));assert.equal(v.spend.denom,'udemo');assert.equal(v.spend.requiredAtomic,'1250000000000000000');safe(v);});
test('Default subaccount INJ spending accounts for gas in the same balance',async()=>{
 const r=request();r.snapshot.market.quote.id='injective:'+CHAIN+'/bank:inj';const f=fake(r,{mutate:(d,u)=>{if(u.includes('/spendable_balances/'))d.balance.amount='150000013818749';}});
 await assert.rejects(execute(r,f),/INSUFFICIENT_SPENDABLE/);assert.equal(f.calls.filter(c=>c.u.includes('/spendable_balances/')).length,1);
});
test('Available balance equality including gas is accepted without double counting',async()=>{
 const r=request();r.snapshot.market.quote.id='injective:'+CHAIN+'/bank:inj';const f=fake(r,{mutate:(d,u)=>{if(u.includes('/spendable_balances/'))d.balance.amount='150000013818750';}});
 const v=await execute(r,f);assert.equal(v.spend.gasSharesBalance,true);safe(v);
});
for(const [name,change,pattern]of [
 ['mainnet',r=>{r.chainId='injective-1';},/TESTNET/],['other public key',r=>{r.publicKeyHex='03'+PUBLIC.slice(2);},/KEY_OWNER/],
 ['invalid public key',r=>{r.publicKeyHex='02'+'ff'.repeat(32);},/PUBLIC_KEY/],['gas fee cap',r=>{r.policy.maxGasFeeAtomic='1';},/GAS_FEE_CAP/],
 ['invalid price',r=>{r.policy.gasPriceAtomic='1e9';},/DECIMAL/],['gas overflow',r=>{r.policy.gasLimit='18446744073709551616';},/COUNTER/],
 ['missing policy',r=>{delete r.policy.gasLimit;},/FIELDS/],['arbitrary message',r=>{r.messages=[];},/FIELDS/],
 ['implicit remote',r=>{r.endpoint='https://example.invalid';},/DISCLOSURE/],['REST subpath',r=>{r.endpoint+='/evil';},/REST_ROOT/]
])test('Invalid input fails before network '+name,async()=>{const r=request();change(r);const f=fake(r);await assert.rejects(execute(r,f),pattern);assert.equal(f.calls.length,0);});
for(const [name,modify,pattern]of [
 ['wrong chain',(d,u)=>{if(d.block)d.block.header.chain_id='other';},/CHAIN_MISMATCH/],
 ['old block',(d,u)=>{if(d.block)d.block.header.time=new Date(NOW-30001).toISOString();},/BLOCK_STALE/],
 ['future block',(d,u)=>{if(d.block)d.block.header.time=new Date(NOW+2001).toISOString();},/BLOCK_STALE/],
 ['bad block hash',(d,u)=>{if(d.block)d.block_id.hash='invalid';},/BLOCK_HASH/],
 ['owner mismatch',(d,u)=>{if(d.account)d.account.base_account.address='other';},/ACCOUNT_OWNER/],
 ['account type',(d,u)=>{if(d.account)d.account['@type']='/evil.Account';},/ACCOUNT_TYPE/],
 ['account overflow',(d,u)=>{if(d.account)d.account.base_account.sequence='18446744073709551616';},/COUNTER/],
 ['account public key',(d,u)=>{if(d.account)d.account.base_account.pub_key.key='AA==';},/ACCOUNT_KEY/],
 ['paused market',(d,u)=>{if(d.market)d.market.status='Paused';},/CHAIN_MARKET/],
 ['different market',(d,u)=>{if(d.market)d.market.market_id='0x'+'ac'.repeat(32);},/CHAIN_MARKET/],
 ['wrong denom',(d,u)=>{if(d.market)d.market.quote_denom='ibc/another';},/ASSET_MISMATCH/],
 ['decimal mismatch',(d,u)=>{if(d.market)d.market.base_decimals='8';},/ASSET_MISMATCH/],
 ['tick mismatch',(d,u)=>{if(d.market)d.market.min_price_tick_size='0.1';},/REQUIREMENTS_CHANGED/],
 ['minimum mismatch',(d,u)=>{if(d.market)d.market.min_notional='2';},/REQUIREMENTS_CHANGED/],
 ['fee changed',(d,u)=>{if(d.market)d.market.taker_fee_rate='0.01';},/FEE_CHANGED/],
 ['maker fee cap',(d,u)=>{if(d.market)d.market.maker_fee_rate='0.006';},/TRADING_FEE_CAP/],
 ['wrong balance denom',(d,u)=>{if(d.balance)d.balance.denom='other';},/BALANCE_DENOM/],
 ['insufficient gas',(d,u)=>{if(d.balance?.denom==='inj')d.balance.amount='149999999999999';},/INSUFFICIENT_GAS/],
 ['insufficient trade',(d,u)=>{if(d.balance?.denom==='uusdx')d.balance.amount='13818749';},/INSUFFICIENT_SPENDABLE/],
 ['simulation zero gas',(d,u)=>{if(d.gas_info)d.gas_info.gas_used='0';},/SIMULATION_RESPONSE/],
 ['simulation mismatched gas',(d,u)=>{if(d.gas_info)d.gas_info.gas_wanted='199999';},/SIMULATION_RESPONSE/],
 ['simulation margin',(d,u)=>{if(d.gas_info)d.gas_info.gas_used='240001';},/GAS_MARGIN/],
 ['simulation no result',(d,u)=>{if(d.gas_info)delete d.result;},/SIMULATION_RESPONSE/],
 ['reorg',(d,u)=>{if(u.endsWith('/blocks/100'))d.block_id.hash='22'.repeat(32);},/BLOCK_CHANGED/],
 ['remote error',(d,u)=>{d.error='sensitive remote text';},/RESPONSE_ERROR/]
])test('Remote inconsistency stops preflight '+name,async()=>{const r=request(),f=fake(r,{mutate:modify});await assert.rejects(execute(r,f),pattern);});
for(const name of ['missing','wrong'])test('Height '+name+' cannot silently fall back to latest state',async()=>{const r=request(),f=fake(r,{headers:{'x-cosmos-block-height':name==='missing'?'':'101'}});await assert.rejects(execute(r,f),/RESPONSE_HEIGHT/);});
test('A new account with null public key still has its supplied key bound to its address',async()=>{const r=request(),f=fake(r,{mutate:d=>{if(d.account)d.account.base_account.pub_key=null;}});safe(await execute(r,f));});
test('Base64 block hashes normalize consistently',async()=>{const r=request(),f=fake(r,{mutate:d=>{if(d.block)d.block_id.hash=Buffer.from(BLOCK,'hex').toString('base64');}});assert.equal((await execute(r,f)).anchor.hash,BLOCK);});
test('Modern sdk_block REST envelope is supported',async()=>{const r=request(),f=fake(r,{mutate:d=>{if(d.block){d.sdk_block=d.block;delete d.block;}}});safe(await execute(r,f));});
test('Conflicting block envelopes are rejected',async()=>{const r=request(),f=fake(r,{mutate:d=>{if(d.block)d.sdk_block={header:{...d.block.header,height:'101'}};}});await assert.rejects(execute(r,f),/BLOCK_AMBIGUOUS/);});
test('Deposit cannot exceed total and absent deposit is not treated as money',async()=>{for(const missing of [false,true]){const r=request();r.input.subaccountId=r.input.subaccountId.slice(0,-1)+'1';const f=fake(r,{mutate:d=>{if(d.deposits){if(missing)delete d.deposits;else d.deposits.total_balance='1';}}});await assert.rejects(execute(r,f),/DEPOSIT/);}});
for(const [name,opts,pattern]of [
 ['non-JSON content',{headers:{'content-type':'text/html'}},/CONTENT_TYPE/],
 ['HTTP failure',{status:503},/HTTP_REJECTED/],
 ['duplicate JSON keys',{raw:()=>'{"block":{},"block":{}}'},/MEMBER_INVALID/],
 ['too many bytes',{raw:()=>'{"x":"'+'a'.repeat(524288)+'"}'},/SIZE_LIMIT/],
 ['bad UTF8',{raw:()=>new Uint8Array([255])},/UTF8/]
])test('Bounded transport rejects '+name,async()=>{const r=request();await assert.rejects(execute(r,fake(r,opts)),pattern);});
test('Abort rejects even fetch implementations that ignore the AbortSignal',async()=>{const r=request(),f=fake(r,{delay:true}),c=new AbortController();const p=preflight(r,{fetchImpl:f.fetchImpl,signal:c.signal,now:()=>NOW});setTimeout(()=>c.abort(),20);await assert.rejects(p,/ABORTED/);});
test('Finite request deadline rejects a hung response stream',async()=>{const r=request();const keep=setTimeout(()=>{},200);try{await assert.rejects(preflight(r,{now:()=>NOW,timeoutMs:100,fetchImpl:async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}})}),/ABORTED/);}finally{clearTimeout(keep);}});
test('Accessors are rejected without executing them',async()=>{const r=request();let reads=0;Object.defineProperty(r,'publicKeyHex',{enumerable:true,get(){reads++;return PUBLIC;}});await assert.rejects(preflight(r));assert.equal(reads,0);});
test('Source input changes during HTTP do not affect the captured request',async()=>{const r=request(),f=fake(r,{mutate:()=>{r.policy.maxGasFeeAtomic='0';r.input.quantity='999';}});const v=await execute(r,f);assert.equal(v.plan.input.quantity,'1.25');safe(v);});
test('Time cannot move backwards and preflight cannot outlive its initial observation',async()=>{for(const times of [[NOW,NOW-1],[NOW,NOW,NOW+30001]]){const r=request(),f=fake(r);let i=0;await assert.rejects(preflight(r,{fetchImpl:f.fetchImpl,now:()=>times[Math.min(i++,times.length-1)]}),/CLOCK|STALE|EXPIRED/);}});
async function localServer(t,now=NOW){const r=request(now),calls=[];const srv=http.createServer(async(req,res)=>{try{const parts=[];for await(const part of req)parts.push(part);const body=Buffer.concat(parts);calls.push({path:req.url,body:body.toString(),method:req.method,headers:req.headers});
 if(req.url.endsWith('/Market')||req.url.endsWith('/OrderbookV2')){const x=demoInputs(now);res.writeHead(200,{'content-type':'application/grpc-web+proto'});res.end(grpc(req.url.endsWith('/Market')?marketBytes(x.market):bookBytes(x.book)));return;}
 const d=dataFor(req.url,r,now);res.writeHead(200,{'content-type':'application/json',...(req.headers['x-cosmos-block-height']?{'x-cosmos-block-height':req.headers['x-cosmos-block-height']}:{})});res.end(JSON.stringify(d));
 }catch{res.writeHead(400,{'content-type':'application/json'});res.end('{}');}});await new Promise(ok=>srv.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>{srv.close(ok);srv.closeAllConnections();}));const endpoint='http://127.0.0.1:'+srv.address().port;
 return {calls,config:{selection:{provider:'injective',network:CHAIN,endpoint,marketId:DEMO_MARKET},input:r.input,endpoint,publicKeyHex:PUBLIC,policy:r.policy}};}
test('Actual loopback HTTP runs existing indexer reader through chain reads and simulation',async t=>{const f=await localServer(t),v=await pipeline(f.config,{now:()=>NOW});safe(v);assert.equal(f.calls.filter(c=>c.path.endsWith('/Market')).length,2);assert.equal(f.calls.filter(c=>c.path.endsWith('/simulate')).length,1);assert.ok(!f.calls.some(c=>c.path.endsWith('/txs')));});
test('Actual CLI request connects both servers and emits an unsigned owner review',async t=>{const f=await localServer(t,Date.now()),dir=fs.mkdtempSync(path.join(os.tmpdir(),'inj-preflight-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const filename=path.join(dir,'request.json');fs.writeFileSync(filename,JSON.stringify(f.config));
 const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['node/spot-preflight.mjs','--request',filename],{cwd:path.resolve(import.meta.dirname,'../../..'),stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',(status,signal)=>resolve({out,err,status,signal}));});assert.equal(result.status,0,result.err);assert.equal(result.signal,null);safe(JSON.parse(result.out));});
test('CLI rejects broadcast and duplicate flags without any request',()=>{for(const args of [['--broadcast','yes'],['--request','x','--request','y']]){const r=spawnSync(process.execPath,['node/spot-preflight.mjs',...args],{cwd:path.resolve(import.meta.dirname,'../../..'),encoding:'utf8',timeout:10000});assert.equal(r.status,1);assert.match(r.stderr,/ARGUMENTS/);}});

test('A query rejection before simulation never submits any transaction bytes',async()=>{const r=request(),f=fake(r,{mutate:d=>{if(d.balance?.denom==='uusdx')d.balance.amount='0';}});await assert.rejects(execute(r,f));assert.ok(f.calls.every(c=>c.o.method==='GET'));});
test('Fractional gas price is rounded upward without floating-point conversion',async()=>{const r=request();r.policy.gasPriceAtomic='0.000000000000000001';r.policy.maxGasFeeAtomic='1';const v=await execute(r,fake(r));assert.equal(v.costs.gasFeeAtomic,'1');safe(v);});
test('Simulation exact gas margin boundary is accepted',async()=>{const r=request(),f=fake(r,{mutate:d=>{if(d.gas_info)d.gas_info.gas_used='240000';}});safe(await execute(r,f));});
test('Whole pipeline validates both disclosure permissions before querying the indexer',async()=>{const r=request(),config={selection:{provider:'injective',network:CHAIN,endpoint:'http://127.0.0.1:1',marketId:DEMO_MARKET},input:r.input,endpoint:'https://secret.invalid',publicKeyHex:PUBLIC,policy:r.policy};let calls=0;await assert.rejects(pipeline(config,{fetchImpl:async()=>{calls++;}}),/DISCLOSURE/);assert.equal(calls,0);});
test('Redirected response is rejected even when a custom fetch ignores redirect:error',async()=>{const r=request();await assert.rejects(preflight(r,{now:()=>NOW,fetchImpl:async()=>({redirected:true})}),/REDIRECT/);});
test('A pre-aborted operation never performs HTTP',async()=>{const c=new AbortController();c.abort();const r=request(),f=fake(r);await assert.rejects(preflight(r,{fetchImpl:f.fetchImpl,signal:c.signal,now:()=>NOW}));assert.equal(f.calls.length,0);});
test('CLI rejects symlink and hard-linked request files',t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inj-file-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'data'),'{}');fs.symlinkSync('data',path.join(dir,'sym'));fs.linkSync(path.join(dir,'data'),path.join(dir,'hard'));for(const n of ['sym','hard']){const r=spawnSync(process.execPath,['node/spot-preflight.mjs','--request',path.join(dir,n)],{cwd:path.resolve(import.meta.dirname,'../../..'),encoding:'utf8',timeout:10000});assert.equal(r.status,1);assert.match(r.stderr,/CLI_FILE/);}});
test('Raw remote exception text is not exposed in diagnostics',async()=>{const r=request();await assert.rejects(preflight(r,{now:()=>NOW,fetchImpl:async()=>{throw Error('https://private.invalid?secret=anything');}}),/^Error: INJ_PREFLIGHT_FAILED$/);});
test('Changed anchor timestamp and mismatched simulation result shape both fail',async()=>{for(const mode of ['time','result']){const r=request(),f=fake(r,{mutate:(d,u)=>{if(mode==='time'&&u.endsWith('/blocks/100'))d.block.header.time=new Date(NOW+1).toISOString();if(mode==='result'&&d.gas_info)d.result=[];}});await assert.rejects(execute(r,f),/BLOCK_CHANGED|SIMULATION_RESPONSE/);}});

// Real-node compatibility regressions: no fallback to missing/latest state.
test('Exact grpc-gateway height metadata is accepted without inventing a height',async()=>{
 const r=request(),f=fake(r);const fetchImpl=async(u,o)=>{const response=await f.fetchImpl(u,o);if(o.headers['x-cosmos-block-height']){response.headers.delete('x-cosmos-block-height');response.headers.set('grpc-metadata-x-cosmos-block-height',o.headers['x-cosmos-block-height']);}return response;};
 const v=await preflight(r,{fetchImpl,now:()=>NOW});safe(v);assert.equal(v.queryApiVersion,'injective.exchange.v2');assert.ok(f.calls.some(x=>x.u.includes('/injective/exchange/v2/spot/markets/')));
});
for(const alternate of ['100','101','', '0100'])test('Dual height headers must agree exactly: '+JSON.stringify(alternate),async()=>{
 const r=request(),f=fake(r,{headers:{'grpc-metadata-x-cosmos-block-height':alternate}});
 if(alternate==='100')safe(await execute(r,f));else await assert.rejects(execute(r,f),/RESPONSE_HEIGHT/);
});
test('Both height header spellings absent remain a hard rejection',async()=>{const r=request(),f=fake(r);const fetchImpl=async(u,o)=>{const response=await f.fetchImpl(u,o);response.headers.delete('x-cosmos-block-height');response.headers.delete('grpc-metadata-x-cosmos-block-height');return response;};await assert.rejects(preflight(r,{fetchImpl,now:()=>NOW}),/RESPONSE_HEIGHT/);});
test('A larger simulation meter does not increase signed gas or fee ceilings',async()=>{
 const r=request(),f=fake(r,{mutate:d=>{if(d.gas_info)d.gas_info.gas_wanted='150000000';}}),v=await execute(r,f);
 assert.equal(v.simulation.gasWanted,'150000000');assert.equal(v.transaction.fee.gasLimit,'300000');assert.equal(v.transaction.fee.amount,'150000000000000');safe(v);
});
for(const wanted of ['0','199999','18446744073709551616'])test('Invalid simulation meter remains rejected '+wanted,async()=>{const r=request(),f=fake(r,{mutate:d=>{if(d.gas_info)d.gas_info.gas_wanted=wanted;}});await assert.rejects(execute(r,f));});
test('Legacy atom quantities cannot be silently interpreted as v2 human units',async()=>{const r=request(),f=fake(r,{mutate:d=>{if(d.market)d.market.min_quantity_tick_size='10000000000000000';}});await assert.rejects(execute(r,f),/REQUIREMENTS_CHANGED/);});
test('Legacy atom prices cannot be silently interpreted as v2 human prices',async()=>{const r=request(),f=fake(r,{mutate:d=>{if(d.market)d.market.min_price_tick_size='0.000000000001';}});await assert.rejects(execute(r,f),/REQUIREMENTS_CHANGED/);});
