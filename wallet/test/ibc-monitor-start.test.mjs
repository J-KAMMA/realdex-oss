import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {IbcController} from '../bridge/controller.mjs';
import {trackingVector} from './ibc-tracking-fixture.mjs';
import {serverFixture} from './fixtures.mjs';

function staleFixture() {
 const v=trackingVector(); const r={...v.record,state:'broadcast'};
 const s={now:()=>v.now,requests:new Map(),settings:{ibcRoutes:[v.route]},activeApproval:false,nonEvm:{busy:false,restartRequired:false},vault:{epoch:1,check(){},status:()=>({locked:false}),nonEvmRecords:async()=>[r]}};
 return {s,r,controller:new IbcController(s)};
}
test('owner stop cancels an earlier start waiting for encrypted history',async()=>{
 const f=staleFixture();let release,entered;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 f.s.vault.nonEvmRecords=async()=>{entered();await gate;return [f.r];};
 const start=f.controller.api('/api/ibc/monitor/start',{ids:[f.r.id]});
 try{await ready;await f.controller.api('/api/ibc/monitor/stop',{});release();await assert.rejects(start,/IBC_MONITOR_START_INVALIDATED/);assert.equal(f.controller.monitor.enabled,false);}
 finally{release();f.controller.invalidate();}
});
test('owner stop invalidates partially uploaded monitor start without requiring wallet lock',async()=>{
 const f=await serverFixture(),v=trackingVector();f.app.settings.ibcRoutes=[v.route];
 f.vault.nonEvmRecords=async()=>[{...v.record,state:'broadcast'}];
 f.app.ibc.monitor.probe=async()=>({report:{stage:'awaiting-receive'}});
 const encoded=JSON.stringify({ids:[v.record.id]});let req;
 try{
  const entered=new Promise(r=>f.app.server.once('request',r));
  const response=new Promise((resolve,reject)=>{
   req=http.request(f.start.origin+'/api/ibc/monitor/start',{method:'POST',headers:{origin:f.start.origin,authorization:'Bearer '+f.app.uiToken,'content-type':'application/json','content-length':Buffer.byteLength(encoded)}},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));
   });req.on('error',reject);req.write(encoded.slice(0,1));
  });
  await entered;await f.call('ibc/monitor/stop');req.end(encoded.slice(1));const result=await response;
  assert.equal(result.status,400);assert.equal(result.body.error,'IBC_MONITOR_START_INVALIDATED');assert.equal((await f.call('ibc/monitor/status')).enabled,false);assert.equal(f.vault.status().locked,false);
 }finally{req?.destroy();await f.close();}
});
