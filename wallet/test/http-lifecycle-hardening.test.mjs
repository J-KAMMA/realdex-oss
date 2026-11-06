import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {serverFixture, PASSWORD} from './fixtures.mjs';

function partialOwnerRequest(f, route, body) {
  const encoded=JSON.stringify(body);const holder={};
  let rejectResponse;
  const response=new Promise((resolve,reject)=>{
    rejectResponse=reject;
    const req=http.request(f.start.origin+'/api/'+route,{method:'POST',headers:{
      origin:f.start.origin,authorization:'Bearer '+f.app.uiToken,
      'content-type':'application/json','content-length':Buffer.byteLength(encoded),
    }},res=>{let chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));});
    holder.req=req;req.on('error',reject);req.write(encoded.slice(0,1));
  });
  const complete=()=>holder.req.end(encoded.slice(1));
  return {response,complete,abort:()=>{holder.req.destroy();rejectResponse(Error('ABORTED_TEST'));}};
}

test('A partially uploaded unlock is invalidated by owner lock before body completion',async()=>{
  const f=await serverFixture();
  try{
    await f.call('lock');
    const entered=new Promise(resolve=>f.app.server.once('request',resolve));
    const pending=partialOwnerRequest(f,'unlock',{password:PASSWORD});await entered;
    await f.call('lock');pending.complete();const r=await pending.response;
    assert.equal(r.status,400);assert.equal(r.body.error,'REQUEST_INVALIDATED_BY_LOCK');
    assert.equal((await f.call('status')).locked,true);
    await f.call('unlock',{password:PASSWORD});assert.equal((await f.call('status')).locked,false);
  }finally{await f.close();}
});

test('Incomplete old-session mutation cannot apply to a freshly unlocked vault',async()=>{
  const f=await serverFixture();
  try{
    const entered=new Promise(resolve=>f.app.server.once('request',resolve));
    const pending=partialOwnerRequest(f,'accounts/add',{family:'icp',label:'stale upload'});await entered;
    await f.call('lock');await f.call('unlock',{password:PASSWORD});
    pending.complete();assert.equal((await pending.response).body.error,'REQUEST_INVALIDATED_BY_LOCK');
    assert.equal((await f.call('status')).accounts.length,1);
  }finally{await f.close();}
});
