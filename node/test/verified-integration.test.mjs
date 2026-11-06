import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIdentity} from '../lib/protocol.mjs';
import {RealDexNode} from '../lib/server.mjs';
import {config} from './fixtures.mjs';
import {VerifiedCatalogue} from '../verified/catalogue.mjs';
import {createReadOnlyRpc,openPinnedReadSession} from '../verified/rpc.mjs';
import {observeLocalPools,simulateObservedPool,planObservedGrossSplit,compareObservedPools} from '../verified/evm.mjs';
import {runReadOnlyRequest,parseReadOnlyConfig} from '../verified/workflow.mjs';
import {NOW,ACCOUNT,F2,P,P2,candidate,request,rpcFixture,TEST_POLICY,OTHER_H} from './verified-fixtures.mjs';

// Actual loopback HTTP; deliberately synthetic chain state, not a Solidity/EVM test.
async function environment(t,{liveClock=false,hook}={}) {
  const now=liveClock?Date.now:()=>NOW,identity=createIdentity();
  const c=config({catalogue:{revision:1,factories:[candidate(),candidate(F2)]}});
  const node=new RealDexNode({identity,config:c,now});const binding=await node.start({port:0,autoSync:false});
  c.allowedHosts=['127.0.0.1:'+binding.port];t.after(()=>node.close());
  // Hash-pinned block timestamps are immutable, even with live wall-clock deadlines.
  const anchorTimestamp=Math.floor(now()/1000);
  const fixture=rpcFixture({hook: async x=>{
    if(liveClock && x.method==='eth_getBlockByNumber')x.value={...x.value,timestamp:'0x'+BigInt(anchorTimestamp).toString(16)};
    return hook?hook(x):x.value;
  }}),rpcUrls=[];
  for(let i=0;i<2;i++) {
    const server=http.createServer(async(req,res)=>{
      let body='';for await(const chunk of req) body+=chunk;
      try{assert.equal(req.method,'POST');const q=JSON.parse(body),result=await fixture.readers[i].send(q.method,q.params);
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
      }catch {res.writeHead(400,{'content-type':'application/json'});res.end('{}');}
    });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    rpcUrls.push('http://127.0.0.1:'+server.address().port);
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  }
  const input={schema:'realdex.readonly-request.v1',nodeUrl:'http://127.0.0.1:'+binding.port,relayPublicKey:identity.publicKey,
    publisherKeys:[identity.publicKey],rpcUrls,request:{...request(),amountIn:'100000'},account:null};
  return {input,fixture,now,node,identity};
}
function exec(args) {
  return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:fileURLToPath(new URL('../..',import.meta.url)),stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);
    child.on('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
}

test('actual HTTP: signed catalogue -> two RPCs -> synthetic owned-policy pools -> simulation -> gross split',async t=>{
  const {input,fixture,now}=await environment(t),catalogue=new VerifiedCatalogue({...input,now});
  const source=await catalogue.pull(input.nodeUrl);assert.equal(source.candidates.length,2);
  const session=await openPinnedReadSession({readers:input.rpcUrls.map(url=>createReadOnlyRpc(url)),chainId:input.request.chainId,now});
  const observed=await observeLocalPools(session,source.candidates,request(),TEST_POLICY);
  assert.deepEqual(observed.pools.map(p=>p.pool),[P,P2]);assert.equal(observed.executable,false);
  const sims=await Promise.all(observed.pools.map(p=>simulateObservedPool(observed,p.routeId,{account:ACCOUNT,recipient:ACCOUNT})));
  assert.equal(sims.length,2);assert(sims.every(s=>s.gas.gasUnits===125000n && s.gas.gasPriceWei===1100000000n));
  assert.equal(compareObservedPools(observed,{simulations:sims}).incomplete.length,2);
  const split=planObservedGrossSplit(observed);assert.equal(split.netOptimality,false);assert.equal(split.executable,false);
  assert(fixture.calls.length>50);assert(fixture.calls.every(c=>!/^eth_send|^wallet_|^personal_/.test(c.method)));
});

test('production workflow refuses synthetic Factory hash despite valid signatures and agreeing RPCs',async t=>{
  const {input,now}=await environment(t);const report=await runReadOnlyRequest(input,{now});
  assert.equal(report.status,'no-verified-pools');assert.equal(report.observation.pools.length,0);
  assert.equal(report.observation.rejected.filter(r=>r.code==='FACTORY_CODE_MISMATCH').length,2);
  assert.equal(report.executable,false);assert.equal(report.walletSigning,false);
});
test('HTTP workflow fails closed when providers disagree on anchor hash',async t=>{
  const {input,now}=await environment(t,{hook:x=>x.index===1&&x.method==='eth_getBlockByNumber'?{...x.value,hash:OTHER_H}:x.value});
  await assert.rejects(runReadOnlyRequest(input,{now}),/RPC_ANCHOR_DISAGREEMENT/);
});
test('HTTP workflow rejects wrong relay key before making an RPC request',async t=>{
  const {input,now,fixture}=await environment(t);input.relayPublicKey=createIdentity().publicKey;
  await assert.rejects(runReadOnlyRequest(input,{now}),/PEER_OR_CHALLENGE_MISMATCH/);assert.equal(fixture.calls.length,0);
});
test('HTTP workflow abort cancels before reads and never sends',async t=>{
  const {input,now,fixture}=await environment(t);const abort=new AbortController();abort.abort(new Error('TEST_CANCELLED'));
  await assert.rejects(runReadOnlyRequest(input,{now,signal:abort.signal}),/TEST_CANCELLED/);assert.equal(fixture.calls.length,0);
});
test('configuration rejects hidden executable policy, numeric amount and equivalent duplicate URLs',async t=>{
  const {input}=await environment(t);
  assert.throws(()=>parseReadOnlyConfig({...input,factoryRuntimeHash:TEST_POLICY.factoryRuntimeHash}),/READONLY_CONFIG_INVALID/);
  assert.throws(()=>parseReadOnlyConfig({...input,request:{...input.request,amountIn:100000}}),/AMOUNT_DECIMAL/);
  assert.throws(()=>parseReadOnlyConfig({...input,rpcUrls:[input.rpcUrls[0],input.rpcUrls[0]+'/']}),/DISTINCT_RPC/);
  assert.throws(()=>parseReadOnlyConfig({...input,nodeUrl:input.nodeUrl+'/v1/status'}),/ROOT_REQUIRED/);
  assert.throws(()=>parseReadOnlyConfig({...input,account:'my private key'}),/ADDRESS_INVALID/);
  const parsed=parseReadOnlyConfig(input);assert(Object.isFrozen(parsed));assert(Object.isFrozen(parsed.rpcUrls));assert.equal(parsed.request.amountIn,100000n);
});
test('CLI completes actual HTTP rejection report, exit3, keeps existing output file unchanged',async t=>{
  const {input}=await environment(t,{liveClock:true});const dir=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-verify-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'request.json'),output=path.join(dir,'report.json');fs.writeFileSync(filename,JSON.stringify(input));
  const first=await exec(['node/verify.mjs','--config',filename,'--output',output]);assert.equal(first.code,3,first.stderr);
  const bytes=fs.readFileSync(output);assert.equal(JSON.parse(bytes).executable,false);
  const second=await exec(['node/verify.mjs','--config',filename,'--output',output]);assert.equal(second.code,1);assert.match(second.stderr,/OUTPUT_EXISTS_NOT_OVERWRITTEN/);
  assert.deepEqual(fs.readFileSync(output),bytes);
});
test('CLI help and invalid args do not require packages, wallet or network',async()=>{
  const help=await exec(['node/verify.mjs','--help']);assert.equal(help.code,0);assert.match(help.stdout,/no custody/);
  const invalid=await exec(['node/verify.mjs','--sign','secret-do-not-echo']);assert.equal(invalid.code,1);assert(!invalid.stderr.includes('secret-do-not-echo'));
});
test('exchange static module graph is served completely with bounded read-only CSP and no test fixture exposure',async t=>{
  const {input}=await environment(t),seen=new Set(),pending=['/node/exchange.mjs'];
  const html=await fetch(input.nodeUrl+'/node/exchange/');assert.equal(html.status,200);
  const csp=html.headers.get('content-security-policy');assert.match(csp,/connect-src 'self' https:/);assert(!csp.includes('unsafe-eval'));assert(!csp.includes('unsafe-inline'));
  assert.match(await html.text(),/署名とチェーン上の情報を検証/);
  const old=await fetch(input.nodeUrl+'/node/');assert.match(old.headers.get('content-security-policy'),/connect-src 'self';/);
  while(pending.length){const pathname=pending.shift();if(seen.has(pathname))continue;seen.add(pathname);
    const res=await fetch(input.nodeUrl+pathname);assert.equal(res.status,200,pathname);assert.match(res.headers.get('content-type'),/javascript/);
    const source=await res.text();for(const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))pending.push(new URL(match[1],input.nodeUrl+pathname).pathname);
  }
  assert(seen.size>=8);for(const endpoint of ['/node/test/verified-fixtures.mjs','/node/verify.mjs','/node/lib/protocol.mjs','/node/verified/workflow.mjs','/node/exchange/execute'])
    assert.equal((await fetch(input.nodeUrl+endpoint)).status,404,endpoint);
  assert.equal((await fetch(input.nodeUrl+'/node/exchange/',{method:'POST'})).status,405);
});
