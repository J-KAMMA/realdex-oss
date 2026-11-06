import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';
import {applicationOptions,startApplication} from '../runtime.mjs';import {doctor} from '../doctor.mjs';
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('One-command options reject conflicts, unsafe privileged ports and unknown settings',()=>{
  assert.equal(applicationOptions().nodePort,8787);
  for(const input of [{nodePort:1},{walletPort:'bad'},{nodePort:8790},{host:'0.0.0.0'},{nodePort:1.5}])assert.throws(()=>applicationOptions(input));
});
test('Doctor inspects code/runtime only and never claims a production release',()=>{const r=doctor();assert.equal(r.secretsRead,false);assert.equal(r.networksContacted,false);assert.equal(r.scope.productionReady,false);assert.ok(r.dependencies.length>0);});
test('Actual isolated child services start, have separate stores and expose no wallet capability in discovery',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-app-test-'));let app;
  try{
    const nodePort=await port();let walletPort=await port();while(walletPort===nodePort)walletPort=await port();
    app=await startApplication({directory,nodePort,walletPort});
    const html=await (await fetch(app.nodeUrl)).text();assert.ok(!html.includes('#key='));assert.ok(!html.includes(app.walletLaunchUrl));
    const wallet=new URL(app.walletLaunchUrl),cap=wallet.hash.slice(5);wallet.hash='';assert.equal((await fetch(wallet)).status,200);
    const r=await fetch(wallet.origin+'/api/status',{method:'POST',headers:{origin:wallet.origin,'content-type':'application/json',authorization:'Bearer '+cap},body:'{}'});const state=await r.json();assert.equal(state.locked,true);assert.equal(state.exists,false);
    assert.ok(fs.existsSync(path.join(directory,'node/identity.json')));assert.ok(!fs.existsSync(path.join(directory,'node/vault.json')));assert.ok(!fs.existsSync(path.join(directory,'wallet/identity.json')));
    await app.close();assert.ok(!fs.existsSync(path.join(directory,'wallet/writer.lock')));
  }finally{await app?.close();fs.rmSync(directory,{recursive:true,force:true});}
});
test('Occupied wallet port causes startup rollback; launcher does not stop the foreign listener',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-app-conflict-'));const foreign=net.createServer();await new Promise(r=>foreign.listen(0,'127.0.0.1',r));
  try{const walletPort=foreign.address().port;let nodePort=await port();while(nodePort===walletPort)nodePort=await port();await assert.rejects(startApplication({directory,nodePort,walletPort}),/SERVICE_EXITED/);assert.equal(foreign.listening,true);assert.ok(!fs.existsSync(path.join(directory,'wallet/writer.lock')));}
  finally{await new Promise(r=>foreign.close(r));fs.rmSync(directory,{recursive:true,force:true});}
});

test('Cancelled start creates no data; abort after readiness closes both services exactly once',async()=>{
  const directory=path.join(os.tmpdir(),'realdex-cancel-'+crypto.randomUUID()),before=new AbortController();before.abort();
  await assert.rejects(startApplication({directory},{signal:before.signal}),/APP_START_ABORTED/);assert.equal(fs.existsSync(directory),false);
  const controller=new AbortController();let app;
  try{const nodePort=await port();let walletPort=await port();while(walletPort===nodePort)walletPort=await port();
    app=await startApplication({directory,nodePort,walletPort},{signal:controller.signal});controller.abort();
    const a=app.close(),b=app.close();assert.equal(a,b);await a;
    assert.equal(fs.existsSync(path.join(directory,'wallet/writer.lock')),false);
    await assert.rejects(fetch(app.nodeUrl));
  }finally{await app?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('Advertised-ready services tolerate repeated immediate abort without stale writer locks',async()=>{
  for(let i=0;i<6;i++){
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-fast-abort-')),controller=new AbortController();let app;
    try{const nodePort=await port();let walletPort=await port();while(walletPort===nodePort)walletPort=await port();app=await startApplication({directory,nodePort,walletPort},{signal:controller.signal});controller.abort();await app.close();assert.equal(fs.existsSync(path.join(directory,'wallet/writer.lock')),false);}finally{await app?.close();fs.rmSync(directory,{recursive:true,force:true});}
  }
});
