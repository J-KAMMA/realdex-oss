#!/usr/bin/env node
/** Actual loopback CLI launch without creating a wallet or sending transactions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import net from 'node:net';import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-cli-smoke-'));
let child;
try {
  const portServer=net.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  child=spawn(process.execPath,['wallet/cli.mjs','start','--directory',directory,'--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe']});
  const exited=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
  let output='';child.stdout.on('data',b=>{output+=b;});let stderr='';child.stderr.on('data',b=>{stderr+=b;});
  const until=Date.now()+5000;while(!/http:\/\/127\.0\.0\.1:\d+\/wallet\/#key=[0-9a-f]{64}/.test(output)&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
  const match=output.match(/http:\/\/127\.0\.0\.1:\d+\/wallet\/#key=[0-9a-f]{64}/);assert.ok(match,'CLI did not produce a private launch URL');const url=new URL(match[0]);
  const response=await fetch(url.origin+'/api/status',{method:'POST',headers:{origin:url.origin,authorization:'Bearer '+url.hash.slice(5),'content-type':'application/json'},body:'{}'});assert.equal(response.status,200);const state=await response.json();assert.equal(state.exists,false);assert.equal(state.locked,true);assert.equal(state.mainnetSigning,false);assert.deepEqual(state.networks,[]);
  const second=spawnSync(process.execPath,['wallet/cli.mjs','start','--directory',directory,'--port',String(port)],{cwd:root,encoding:'utf8',timeout:5000});assert.equal(second.status,1);assert.match(second.stderr,/VAULT_IN_USE_OR_STALE_LOCK/);
  child.kill('SIGTERM');const end=await exited;assert.equal(end.code,0);assert.equal(stderr,'');assert.equal(fs.existsSync(path.join(directory,'writer.lock')),false);assert.equal(fs.existsSync(path.join(directory,'vault.json')),false);
  if(process.platform!=='win32')assert.equal(fs.statSync(path.join(directory,'settings.json')).mode&0o777,0o600);
  output='';console.log(JSON.stringify({passed:true,mode:'actual-cli-loopback-http',startup:true,uiCapabilityAuthorization:true,initialNoNetworkOrVault:true,duplicateWriterRejected:true,cleanShutdown:true,realChain:false,realBrowser:false,privateLaunchUrlRecorded:false},null,2));
} finally { if(child&&child.exitCode===null)child.kill('SIGTERM');fs.rmSync(directory,{recursive:true,force:true}); }
