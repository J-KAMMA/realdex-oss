import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {AccountRest,validateAccountNetwork,decimalAtomic,int,hash} from '../non-evm/account-network.mjs';
import {accountOnlineFixture} from './account-online-fixtures.mjs';
const n={family:'stellar',id:'stellar:standalone',name:'Synthetic boundary test',rpcUrls:['http://127.0.0.1:8001/','http://127.0.0.1:8002/'],checkpoint:{height:1,hash:'11'.repeat(32)},broadcastEnabled:false,maxTransferAtomic:'1000000',maxFeeAtomic:'10000',minConfirmations:1,networkPassphrase:'Standalone Network ; February 2017'};
async function cli(args){const p=spawn(process.execPath,['wallet/non-evm/account-config.mjs',...args],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);const [code]=await once(p,'close');return {code,stdout,stderr};}
for(const family of ['stellar','aptos'])test(`${family} checkpoint collector is read-only and will not overwrite files`,async t=>{
 const f=await accountOnlineFixture(family);t.after(()=>f.close());const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rdx-collector-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const target=path.join(dir,'network.json'),args=['--family',family,...f.network.rpcUrls.flatMap(url=>['--rpc-url',url]),'--checkpoint-height','1','--output',target];
 const first=await cli(args);assert.equal(first.code,0,first.stderr);const written=fs.readFileSync(target,'utf8'),report=JSON.parse(first.stdout),network=validateAccountNetwork(JSON.parse(written));
 assert.equal(report.independentlyTrusted,false);assert.equal(network.broadcastEnabled,false);assert.deepEqual(network.checkpoint,f.network.checkpoint);assert.equal(f.state.sent,0);assert.equal(f.state.simulations,0);
 if(process.platform!=='win32')assert.equal(fs.statSync(target).mode&0o777,0o600);
 const second=await cli(args);assert.notEqual(second.code,0);assert.equal(fs.readFileSync(target,'utf8'),written);assert.equal(f.state.sent,0);
});
test('collector refuses repeated options and public URLs without creating output',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rdx-collector-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const target=path.join(dir,'never.json');
 for(const args of [ ['--family','stellar','--family','aptos'], ['--family','stellar','--rpc-url','https://example.com/','--rpc-url','http://127.0.0.1:9999/','--checkpoint-height','1'] ]){const result=await cli([...args,'--output',target]);assert.notEqual(result.code,0);assert.equal(fs.existsSync(target),false);}
});
test('local REST rejects oversized streamed responses',async()=>{
 const rest=new AccountRest({fetchImpl:async()=>new Response('x'.repeat(524289),{headers:{'content-type':'application/json'}})});
 await assert.rejects(rest.call(n,0,''),/RESPONSE_LIMIT/);
});
test('local REST rejects non JSON and malformed JSON replies',async()=>{
 for(const [body,type,error]of [['{}','text/html',/CONTENT_TYPE/],['{broken','application/json',/JSON_INVALID/]]){
  const rest=new AccountRest({fetchImpl:async()=>new Response(body,{headers:{'content-type':type}})});await assert.rejects(rest.call(n,0,''),error);
 }
});
test('local REST treats submit errors as uncertain without returning server contents',async()=>{
 const rest=new AccountRest({fetchImpl:async()=>new Response(JSON.stringify({sensitive:'not-in-error'}),{status:504,headers:{'content-type':'application/json'}})});
 await assert.rejects(rest.call(n,0,'transactions',{method:'POST',body:'tx=test'}),e=>e.message==='ACCOUNT_RPC_HTTP_ERROR'&&!e.message.includes('not-in-error'));
});
test('local REST forbids arbitrary signer methods and traversal before contacting RPC',async()=>{
 let calls=0;const rest=new AccountRest({fetchImpl:async()=>{calls++;return new Response('{}');}});
 for(const [p,method]of [['../admin','GET'],['/accounts/a','GET'],['https://example.com','GET'],['wallet/sign','POST'],['transactions','DELETE']])await assert.rejects(rest.call(n,0,p,{method}));
 assert.equal(calls,0);
});
test('local REST network targets reject credentials, DNS names, paths and aliases',()=>{
 for(const url of ['http://localhost:8001/','http://127.0.0.1:8001/?token=x','http://user:pass@127.0.0.1:8001/','http://127.0.0.1:8001/admin/','https://127.0.0.1:8001/','http://127.0.0.1:8001/#key=x'])assert.throws(()=>validateAccountNetwork({...n,rpcUrls:[url,n.rpcUrls[1]]}));
 assert.throws(()=>validateAccountNetwork({...n,rpcUrls:[n.rpcUrls[0],n.rpcUrls[0]]}),/DUPLICATE/);
});
test('local REST actual HTTP redirect is not followed',async t=>{
 let targetHits=0;const target=http.createServer((req,res)=>{targetHits++;res.setHeader('content-type','application/json');res.end('{}');});target.listen(0,'127.0.0.1');await once(target,'listening');t.after(()=>new Promise(r=>target.close(r)));
 const redirect=http.createServer((req,res)=>{res.writeHead(307,{location:`http://127.0.0.1:${target.address().port}/`});res.end();});redirect.listen(0,'127.0.0.1');await once(redirect,'listening');t.after(()=>new Promise(r=>redirect.close(r)));
 const network={...n,rpcUrls:[`http://127.0.0.1:${redirect.address().port}/`,`http://127.0.0.1:${target.address().port}/`]};await assert.rejects(new AccountRest().call(network,0,''),/TRANSPORT_UNCERTAIN/);assert.equal(targetHits,0);
});
test('local REST requires projected agreement, and optional not-found remains null',async()=>{
 const rest=new AccountRest({fetchImpl:async url=>url.includes(':8001')?new Response('{"value":1}',{headers:{'content-type':'application/json'}}):new Response('{"value":2}',{headers:{'content-type':'application/json'}})});
 await assert.rejects(rest.agree(n,'',undefined,v=>v.value),/DISAGREEMENT/);
 const none=new AccountRest({fetchImpl:async()=>new Response('',{status:404})});assert.equal(await none.call(n,0,'transactions/'+'a'.repeat(64),{notFound:true}),null);
});
test('RPC numeric boundaries and exact amount handling do not round',()=>{
 assert.equal(decimalAtomic('0.0000001',7),'1');assert.equal(decimalAtomic('1.25000000',8),'125000000');
 for(const value of ['0.00000001','1e-7','NaN','-1','01',' 1','1.'])assert.throws(()=>decimalAtomic(value,7));
 assert.throws(()=>int('9007199254740992'));assert.throws(()=>int('01'));assert.throws(()=>int(0.1));
 assert.throws(()=>hash('0'.repeat(64)));assert.throws(()=>hash('0x'+'0'.repeat(64),true));
});
