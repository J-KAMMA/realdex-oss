import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {observeChain} from '../chains/observation.mjs';import {FAMILIES} from '../chains/registry.mjs';
import {wire,request,NOW,profile} from './multichain-fixtures.mjs';
import {RealDexNode} from '../lib/server.mjs';import {createIdentity} from '../lib/protocol.mjs';import {config} from './fixtures.mjs';
async function mock(t,family){let count=0;const s=http.createServer(async(req,res)=>{const chunks=[];for await(const x of req)chunks.push(x);try{const data=wire(family,'http://127.0.0.1'+req.url,{body:Buffer.concat(chunks).toString('utf8')||undefined});count++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));}catch{res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"FIXTURE_FAILURE"}');}});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();return new Promise(r=>s.close(r));});return {url:'http://127.0.0.1:'+s.address().port,count:()=>count};}
for(const family of FAMILIES)test(family+': actual local HTTP to two synthetic protocol servers',async t=>{
 const a=await mock(t,family),b=await mock(t,family),r=request(family);delete r.fetchImpl;r.endpoints=[a.url,b.url];const out=await observeChain(r);assert.equal(out.family,family);assert(out.assurance.rpcAgreement);assert.equal(out.executable,false);assert(a.count()>=3&&b.count()>=3);
});
test('new static page serves only explicit assets and cannot expose local configuration',async t=>{
 const c=config(),node=new RealDexNode({identity:createIdentity(),config:c});const addr=await node.start({port:0,autoSync:false});c.allowedHosts=['127.0.0.1:'+addr.port];t.after(()=>node.close());const base='http://127.0.0.1:'+addr.port;
 const page=await fetch(base+'/node/chains/');assert.equal(page.status,200);assert(page.headers.get('content-security-policy').includes("connect-src 'self' https:"));assert((await page.text()).includes('取引送信'));
 const profiles=await(await fetch(base+'/node/chains/profiles.json')).json();assert.equal(profiles.profiles.length,138);
 for(const name of ['core','registry','transport','adapters','observation','assets'])assert.equal((await fetch(base+'/node/chains/'+name+'.mjs')).status,200);
 for(const name of ['deployment.mjs','config.json','../../.env'])assert.notEqual((await fetch(base+'/node/chains/'+name)).status,200);
});
