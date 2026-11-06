import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {createReadOnlyRpc,openPinnedReadSession,quantity} from '../verified/rpc.mjs';
import {rpcFixture,NOW,H,OTHER_H,F,FACTORY_CODE} from './verified-fixtures.mjs';
const open=(f,extra={})=>openPinnedReadSession({readers:f.readers,chainId:'eip155:84532',now:()=>NOW,...extra});
test('opens common confirmed block instead of mixing latest reads',async()=>{const f=rpcFixture(),s=await open(f);assert.equal(s.anchor.number,99n);assert.equal(s.anchor.hash,H);assert.equal(s.anchor.confirmations,2);assert.equal(s.anchor.expiresAt,NOW+30000);});
test('all code and call reads require same canonical blockHash',async()=>{const f=rpcFixture(),s=await open(f);assert.equal(await s.read('eth_getCode',[F]),FACTORY_CODE);assert.deepEqual(f.calls.filter(x=>x.method==='eth_getCode').map(x=>x.params[1]),[{blockHash:H,requireCanonical:true},{blockHash:H,requireCanonical:true}]);});
test('read through cache coalesces concurrent identical reads',async()=>{const f=rpcFixture(),s=await open(f);await Promise.all(Array.from({length:20},()=>s.read('eth_getCode',[F])));assert.equal(f.calls.filter(x=>x.method==='eth_getCode').length,2);});
test('one failed read is not cached as proof',async()=>{let once=true;const f=rpcFixture({hook:x=>{if(x.method==='eth_getCode'&&x.index===0&&once){once=false;throw new Error('TEMPORARY_RPC_FAILURE');}return x.value;}}),s=await open(f);await assert.rejects(s.read('eth_getCode',[F]),/TEMPORARY/);assert.equal(await s.read('eth_getCode',[F]),FACTORY_CODE);});
for(const [name,hook,code] of [
 ['wrong chain',x=>x.method==='eth_chainId'&&x.index===1?'0x1':x.value,'CHAIN_MISMATCH'],
 ['different anchor',x=>x.method==='eth_getBlockByNumber'&&x.params[0]!=='latest'&&x.index===1?{...x.value,hash:OTHER_H}:x.value,'ANCHOR_DISAGREEMENT'],
 ['wrong block number',x=>x.method==='eth_getBlockByNumber'&&x.params[0]!=='latest'?{...x.value,number:'0x1'}:x.value,'ANCHOR_DISAGREEMENT'],
 ['stale blocks',x=>x.method==='eth_getBlockByNumber'?{...x.value,timestamp:'0x1'}:x.value,'STALE'],
 ['future blocks',x=>x.method==='eth_getBlockByNumber'?{...x.value,timestamp:'0x'+BigInt(NOW/1000+1000).toString(16)}:x.value,'FUTURE'],
 ['head lag',x=>x.method==='eth_getBlockByNumber'&&x.params[0]==='latest'&&x.index===1?{...x.value,number:'0xff'}:x.value,'FAR_APART'],
 ['malformed head',x=>x.method==='eth_getBlockByNumber'?null:x.value,'BLOCK_INVALID'],
 ['leading-zero quantity',x=>x.method==='eth_chainId'?'0x014a34':x.value,'QUANTITY_INVALID']
])test(`snapshot refuses ${name}`,async()=>await assert.rejects(open(rpcFixture({hook})),new RegExp(code)));
test('duplicate or lone readers cannot become quorum',async()=>{const f=rpcFixture();await assert.rejects(open(f,{readers:[f.readers[0]]}),/DISTINCT/);await assert.rejects(open(f,{readers:[f.readers[0],f.readers[0]]}),/DISTINCT/);});
test('RPC disagreement invalidates the whole session including cached values',async()=>{const f=rpcFixture({hook:x=>x.method==='eth_getCode'&&x.index===1?'0x00':x.value}),s=await open(f);await assert.rejects(s.read('eth_getCode',[F]),/DISAGREEMENT/);assert.throws(()=>s.time(),/DISAGREEMENT/);await assert.rejects(s.verifyCurrent(),/DISAGREEMENT/);});
test('no fallback to latest when EIP-1898 is unsupported',async()=>{const f=rpcFixture({hook:x=>{if(x.method==='eth_getCode')throw new Error('RPC_REMOTE_ERROR');return x.value;}}),s=await open(f);await assert.rejects(s.read('eth_getCode',[F]),/RPC_REMOTE_ERROR/);assert.equal(f.calls.filter(x=>x.method==='eth_getCode').length,2);assert.ok(f.calls.filter(x=>x.method==='eth_getCode').every(x=>typeof x.params[1]==='object'));});
test('reorg detected at final recheck',async()=>{const f=rpcFixture(),s=await open(f);f.block.hash=OTHER_H;await assert.rejects(s.verifyCurrent(),/REORG/);});
test('chain change detected at final recheck',async()=>{let changed=false;const f=rpcFixture({hook:x=>changed&&x.method==='eth_chainId'?'0x1':x.value}),s=await open(f);changed=true;await assert.rejects(s.verifyCurrent(),/CHAIN_CHANGED/);});
test('expiry blocks cached reads',async()=>{let n=NOW;const f=rpcFixture(),s=await open(f,{now:()=>n});await s.read('eth_getCode',[F]);n+=30000;await assert.rejects(s.read('eth_getCode',[F]),/EXPIRED/);});
test('clock rollback invalidates session',async()=>{let n=NOW;const s=await open(rpcFixture(),{now:()=>n});n--;assert.throws(()=>s.time(),/BACKWARDS/);});
test('cancellation blocks already cached state',async()=>{const controller=new AbortController(),s=await open(rpcFixture(),{signal:controller.signal});controller.abort();await assert.rejects(s.read('eth_getCode',[F]));});
test('snapshot methods reject signing and caller-supplied block tags',async()=>{const s=await open(rpcFixture());await assert.rejects(s.read('eth_sendTransaction',[{}]),/METHOD_FORBIDDEN/);await assert.rejects(s.read('eth_getCode',[F,'latest']),/PARAMS_INVALID/);});
for(const p of [{confirmations:0},{ttlMs:1000000},{maxAgeMs:0},{maxHeadGap:100},{unexpected:true}])test(`invalid read policy ${JSON.stringify(p)}`,async()=>await assert.rejects(open(rpcFixture(),{policy:p})));
test('gas estimates use conservative max and bracketed explicit number',async()=>{const f=rpcFixture(),s=await open(f),gas=await s.estimateGas({from:F,to:F,data:'0x',value:'0x0'});assert.equal(gas.gasUnits,125000n);assert.equal(gas.gasPriceWei,1100000000n);assert.ok(f.calls.filter(x=>x.method==='eth_estimateGas').every(x=>x.params[1]==='0x63'));});
for(const method of ['eth_sendTransaction','eth_sendRawTransaction','personal_sign','eth_requestAccounts','wallet_switchEthereumChain','debug_traceCall'])test(`transport forbids ${method} before network`,async()=>{let calls=0;const rpc=createReadOnlyRpc('http://127.0.0.1:8545',{fetchImpl:()=>{calls++;throw new Error('NETWORK');}});await assert.rejects(rpc.send(method,[]),/METHOD_FORBIDDEN/);assert.equal(calls,0);});
test('JSON-RPC response id and mixed result/error rejected',async()=>{for(const mutate of [x=>({...x,id:x.id+1}),x=>({...x,error:{code:-1}})]){const rpc=createReadOnlyRpc('http://127.0.0.1:8545',{fetchImpl:async(_url,opts)=>{const q=JSON.parse(opts.body);return new Response(JSON.stringify(mutate({jsonrpc:'2.0',id:q.id,result:'0x1'})),{headers:{'content-type':'application/json'}});}});await assert.rejects(rpc.send('eth_chainId',[]));}});
test('transport hides server error text',async()=>{const rpc=createReadOnlyRpc('http://127.0.0.1:8545',{fetchImpl:async(_url,opts)=>new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(opts.body).id,error:{code:-32000,message:'secret credential url'}}),{headers:{'content-type':'application/json'}})});await assert.rejects(rpc.send('eth_chainId',[]),e=>e.message==='RPC_REMOTE_ERROR'&&e.rpcCode===-32000);});
test('JSON RPC with actual loopback HTTP and bounded concurrent requests',async t=>{
 let active=0,peak=0,total=0;const server=http.createServer((req,res)=>{active++;peak=Math.max(peak,active);let body='';req.on('data',x=>body+=x);req.on('end',()=>{const q=JSON.parse(body);setTimeout(()=>{total++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result:'0x14a34'}));active--;},5);});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const rpc=createReadOnlyRpc(`http://127.0.0.1:${server.address().port}`);const values=await Promise.all(Array.from({length:25},()=>rpc.send('eth_chainId',[])));
 assert.equal(values.length,25);assert.equal(total,25);assert.ok(peak<=4);
});
test('timed-out in-flight and queued requests release all semaphore permits',async()=>{
 let active=0,peak=0,slow=true;const rpc=createReadOnlyRpc('http://127.0.0.1:8545',{timeoutMs:100,fetchImpl:async(_url,opts)=>{active++;peak=Math.max(peak,active);try{if(slow)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,300);opts.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(opts.signal.reason);},{once:true});});return new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(opts.body).id,result:'0x1'}),{headers:{'content-type':'application/json'}});}finally{active--;}}});
 const outcomes=await Promise.allSettled(Array.from({length:12},()=>rpc.send('eth_chainId',[])));assert.ok(outcomes.every(x=>x.status==='rejected'));assert.ok(peak<=4);
 slow=false;assert.equal((await Promise.all(Array.from({length:8},()=>rpc.send('eth_chainId',[])))).length,8);
});
