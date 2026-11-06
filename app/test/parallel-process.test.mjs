import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {runPool,runProcess,testEnvironment} from '../lib/parallel-process.mjs';
import {CI_SUITES,suiteCommand} from '../lib/ci-suites.mjs';
import {processEvidence} from '../lib/acceptance.mjs';
const ROOT=path.resolve(new URL('../..',import.meta.url).pathname);
function dir(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-parallel-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
test('Parallel pool executes once with a fixed maximum; failures do not hide other jobs',async()=>{
  let running=0,max=0;const visited=[];
  const result=await runPool([0,1,2,3,4],async n=>{running++;max=Math.max(max,running);visited.push(n);await new Promise(r=>setTimeout(r,20));running--;if(n===2)throw Error('fixture');return {status:'passed',n};},{concurrency:2});
  assert.equal(max,2);assert.deepEqual([...visited].sort(),[0,1,2,3,4]);assert.equal(result[2].status,'failed');assert.equal(result[4].n,4);
});
for(const value of [0,-1,1.5,5,'3'])test('Parallel rejects invalid concurrency '+value,async()=>assert.rejects(runPool([1],async()=>{}, {concurrency:value}),/CI_CONCURRENCY/));
test('Pre-aborted queued jobs never start',async()=>{const c=new AbortController();c.abort();let n=0;const r=await runPool([1,2],async()=>n++,{signal:c.signal});assert.equal(n,0);assert.ok(r.every(x=>x.status==='cancelled'));});
test('CI environment strips wallet credentials, agent token, NODE_OPTIONS and inherited startup scripts',()=>{
  const e=testEnvironment({PATH:'/bin',HOME:'/tmp/test',REALDEX_OWNER_KEY:'secret',REALDEX_AGENT_TOKEN:'secret',NODE_OPTIONS:'--require bad',GITHUB_TOKEN:'secret',BASH_ENV:'bad'});
  assert.equal(e.PATH,'/bin');for(const k of ['REALDEX_OWNER_KEY','REALDEX_AGENT_TOKEN','NODE_OPTIONS','GITHUB_TOKEN','BASH_ENV'])assert.equal(e[k],undefined);
});
test('A real child produces independently checked TAP evidence',async t=>{
  const p=dir(t);const r=await runProcess({command:process.execPath,args:['-e','console.log("# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0")'],cwd:p,log:path.join(p,'log'),timeoutMs:5000});
  assert.equal(processEvidence(r,fs.readFileSync(path.join(p,'log'),'utf8'),{requireTap:true}).status,'passed');assert.ok(r.durationMs>=0);
});
test('Timeout cannot become a passing process and kills an owned child',async t=>{
  const p=dir(t),r=await runProcess({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:p,log:path.join(p,'log'),timeoutMs:100});
  assert.equal(r.reason,'CI_TIMEOUT');assert.equal(processEvidence(r,'',{requireTap:true}).status,'failed');
});
test('Explicit cancellation terminates a running child',async t=>{
  const p=dir(t),c=new AbortController();const job=runProcess({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:p,log:path.join(p,'log'),timeoutMs:5000,signal:c.signal});setTimeout(()=>c.abort(),80);
  const r=await job;assert.equal(r.reason,'CI_ABORTED');
});
test('Missing executable is evidence of failure rather than a skipped suite',async t=>{
  const p=dir(t),r=await runProcess({command:path.join(p,'missing'),cwd:p,log:path.join(p,'log')});assert.ok(r.error);assert.equal(processEvidence(r,'',{requireTap:true}).status,'failed');
});
test('Logs are created exclusively, never overwritten',async t=>{const p=dir(t),log=path.join(p,'log');fs.writeFileSync(log,'preserve');await assert.rejects(runProcess({command:process.execPath,cwd:p,log}),/EEXIST/);assert.equal(fs.readFileSync(log,'utf8'),'preserve');});
test('All named suites are discovered and unknown names cannot select arbitrary commands',()=>{
  assert.equal(CI_SUITES.length,5);for(const name of CI_SUITES)assert.ok(suiteCommand(ROOT,name).length);
  assert.throws(()=>suiteCommand(ROOT,'../../bin/sh'),/CI_UNKNOWN_SUITE/);
});

test('A short-lived child cannot evade the log limit by exiting before the monitor',async t=>{
 const p=dir(t),r=await runProcess({command:process.execPath,args:['-e','process.stdout.write("x".repeat(4096))'],cwd:p,log:path.join(p,'log'),maxLogBytes:1024});assert.equal(r.reason,'CI_LOG_LIMIT');assert.equal(processEvidence(r,'',{requireTap:false}).status,'failed');
});
test('Aborting a pool does not start the jobs still waiting in its queue',async()=>{
 const c=new AbortController(),ran=[];const r=await runPool([1,2,3],async n=>{ran.push(n);c.abort();return {status:'passed'};},{concurrency:1,signal:c.signal});assert.deepEqual(ran,[1]);assert.equal(r[1].status,'cancelled');assert.equal(r[2].status,'cancelled');
});
