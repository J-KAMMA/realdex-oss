import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {walletTestPlan,runWalletTests,MAX_WALLET_TEST_JOBS} from '../../dev/wallet-test-runner.mjs';
import {processEvidence} from '../lib/acceptance.mjs';
import {runProcess} from '../lib/parallel-process.mjs';
const ROOT=path.resolve(import.meta.dirname,'../..');
function fixture(t,entries={'z.test.mjs':"import test from 'node:test';test('z',()=>{});",'a.test.mjs':"import test from 'node:test';test('a',()=>{});"}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-wallet-runner-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 for(const [name,source]of Object.entries(entries))fs.writeFileSync(path.join(directory,name),source);
 return directory;
}
function actual(directory,jobs='2'){
 const plan=walletTestPlan(directory,['--jobs',jobs],{cpuCount:2});
 const result=spawnSync(process.execPath,[...plan.args],{cwd:directory,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH},shell:false});
 return {...result,evidence:processEvidence(result,result.stdout??'',{requireTap:true})};
}
test('Wallet scheduler caps at two isolated file processes and preserves a sorted complete inventory',t=>{
 const dir=fixture(t,{'z.test.mjs':'','a.test.mjs':'','helper.mjs':'','not-test.txt':''});
 const p=walletTestPlan(dir,[],{cpuCount:128});assert.equal(p.concurrency,2);assert.equal(MAX_WALLET_TEST_JOBS,2);
 assert.deepEqual(p.files,[path.join(dir,'a.test.mjs'),path.join(dir,'z.test.mjs')]);
 assert.deepEqual(p.args,['--test','--test-concurrency=2','--experimental-test-isolation=process','--test-reporter=tap',...p.files]);
 assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.args)&&Object.isFrozen(p.files));
});
for(const [cpu,jobs,expected]of [[1,[],1],[2,[],2],[4,['--jobs','1'],1],[4,['--jobs','2'],2],[1,['--jobs','2'],1]])test(`Bounded resources cpu=${cpu},args=${JSON.stringify(jobs)}`,t=>assert.equal(walletTestPlan(fixture(t),jobs,{cpuCount:cpu}).concurrency,expected));
test('A single discovered file never starts an unused parallel worker',t=>assert.equal(walletTestPlan(fixture(t,{'a.test.mjs':''}),[],{cpuCount:8}).concurrency,1));
for(const args of [['--jobs'],['--jobs','0'],['--jobs','3'],['--jobs','02'],['--jobs','1.0'],['--jobs','-1'],['--jobs','Infinity'],['--jobs','NaN'],['--jobs','2','--jobs','1'],['--test-only'],['--test-name-pattern','a'],['--test-skip-pattern','a'],['--test-shard','1/2'],['--test-force-exit'],['a.test.mjs'],[2],null])test('Cannot filter, shard or relax complete-suite execution '+JSON.stringify(args),t=>{
 let invoked=false;assert.throws(()=>runWalletTests(fixture(t),args,{run:()=>{invoked=true;}}),/ARGUMENTS/);assert.equal(invoked,false);
});
for(const cpuCount of [0,-1,1.2,Infinity,'2',null])test('Reject invalid CPU count '+JSON.stringify(cpuCount),t=>assert.throws(()=>walletTestPlan(fixture(t),[],{cpuCount}),/CPU_COUNT/));
test('Empty discovery cannot fall back to Node recursive whole-repository discovery',t=>assert.throws(()=>walletTestPlan(fixture(t,{'helper.mjs':''})),/DISCOVERY/));
test('A matching directory is not accepted as a test file',t=>{const dir=fixture(t);fs.mkdirSync(path.join(dir,'bad.test.mjs'));assert.throws(()=>walletTestPlan(dir),/NONREGULAR/);});
test('Symlink tests cannot silently replace the selected inventory',t=>{const dir=fixture(t);fs.symlinkSync('a.test.mjs',path.join(dir,'alias.test.mjs'));assert.throws(()=>walletTestPlan(dir),/NONREGULAR/);});
test('Oversized discovery fails rather than silently truncating the suite',t=>{const dir=fixture(t,{});for(let i=0;i<513;i++)fs.writeFileSync(path.join(dir,i+'.test.mjs'),'');assert.throws(()=>walletTestPlan(dir),/DISCOVERY/);});
test('Relative directory rejected',()=>assert.throws(()=>walletTestPlan('wallet/test'),/DIRECTORY/));
for(const [name,result,expected]of [
 ['success',{status:0,signal:null},0],['failed assertion',{status:1},1],['different nonzero',{status:2},2],
 ['signal',{status:null,signal:'SIGTERM'},1],['signal despite zero',{status:0,signal:'SIGKILL'},1],
 ['spawn error',{status:0,error:Error('ENOENT')},1],['timeout',{status:null,error:{code:'ETIMEDOUT'}},1],
 ['missing result',undefined,1],['missing status',{},1],['negative status',{status:-1},1],['noninteger',{status:0.5},1],['string status',{status:'0'},1]
])test('Propagate child outcome '+name,t=>assert.equal(runWalletTests(fixture(t),[],{cpuCount:2,run:()=>result,write:()=>{}}),expected));
test('No ambient Node flags, runtime keys, wallet env or proxy can override test scheduling',t=>{
 const dir=fixture(t);let call,comment='';const status=runWalletTests(dir,[],{cpuCount:2,environment:{PATH:process.env.PATH,HOME:'/tmp',NODE_OPTIONS:'--test-only',REALDEX_ANVIL_BINARY:'/unapproved',SECRET:'private',HTTP_PROXY:'http://invalid',UV_THREADPOOL_SIZE:'128'},write:x=>comment+=x,run:(command,args,options)=>{call={command,args,options};return {status:0};}});
 assert.equal(status,0);assert.equal(call.command,process.execPath);assert.equal(call.options.shell,false);assert.equal(call.options.stdio,'inherit');
 assert.deepEqual(call.options.env,{CI:'1',REALDEX_REQUIRE_OFFLINE_SOLC:'1',PATH:process.env.PATH,HOME:'/tmp'});
 assert.match(comment,/^# RealDEX wallet test files=2 concurrency=2 isolation=process\n$/);
});
test('Real files run in separate processes and preserve serial order inside each file',t=>{
 const source=name=>`import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';let state=0;test('${name}:first',()=>{assert.equal(state,0);state++;globalThis.marker='${name}';fs.writeFileSync('${name}.pid',String(process.pid));});test('${name}:second',()=>{assert.equal(state,1);assert.equal(globalThis.marker,'${name}');});`;
 const dir=fixture(t,{'a.test.mjs':source('a'),'b.test.mjs':source('b')});const r=actual(dir);assert.equal(r.status,0,r.stderr);assert.equal(r.evidence.status,'passed');assert.equal(r.evidence.counts.tests,4);
 assert.notEqual(fs.readFileSync(path.join(dir,'a.pid'),'utf8'),fs.readFileSync(path.join(dir,'b.pid'),'utf8'));
});
test('Real concurrency barrier proves two files overlap',t=>{
 const source=name=>`import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';test('${name}',async()=>{fs.writeFileSync('${name}.started','1');const until=Date.now()+4000;while(!fs.existsSync('${name==='a'?'b':'a'}.started')){assert.ok(Date.now()<until,'parallel peer missing');await new Promise(r=>setTimeout(r,10));}});`;
 const r=actual(fixture(t,{'a.test.mjs':source('a'),'b.test.mjs':source('b')}));assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(r.evidence.counts.pass,2);
});
test('Assertion failure does not prevent the other queued files from running or become a pass',t=>{
 const dir=fixture(t,{'a.test.mjs':"import test from 'node:test';test('intentional-failure',()=>{throw Error('fixture');});",'b.test.mjs':"import test from 'node:test';test('still-run',()=>{});",'c.test.mjs':"import test from 'node:test';test('last-run',()=>{});"});
 const r=actual(dir);assert.equal(r.status,1);assert.equal(r.evidence.status,'failed');assert.equal(r.evidence.counts.tests,3);assert.equal(r.evidence.counts.fail,1);assert.equal(r.evidence.counts.pass,2);
});
test('A skipped test remains visible and fails existing acceptance rules',t=>{
 const r=actual(fixture(t,{'a.test.mjs':"import test from 'node:test';test.skip('must-not-count-as-success',()=>{});"}));assert.equal(r.evidence.status,'failed');assert.equal(r.evidence.counts.skipped,1);
});
test('A child that signals itself produces failure, not empty success',t=>{
 const r=actual(fixture(t,{'a.test.mjs':"process.kill(process.pid,'SIGTERM');"}));assert.notEqual(r.status,0);assert.equal(r.evidence.status,'failed');
});
test('Serial and parallel execution keep all named tests and totals',t=>{
 const dir=fixture(t);const a=actual(dir,'1'),b=actual(dir,'2');for(const r of [a,b])assert.equal(r.evidence.status,'passed');
 assert.deepEqual(a.evidence.counts,b.evidence.counts);const names=s=>[...s.matchAll(/^# Subtest: (.+)$/gm)].map(x=>x[1]);assert.deepEqual(names(a.stdout),names(b.stdout));
});
test('Existing process-group timeout still stops parallel workers and leaves no success report',async t=>{
 const dir=fixture(t,{'a.test.mjs':"setInterval(()=>{},1000);",'b.test.mjs':"setInterval(()=>{},1000);"});
 const plan=walletTestPlan(dir,[],{cpuCount:2}),log=path.join(dir,'timeout.tap');
 const result=await runProcess({command:process.execPath,args:[...plan.args],cwd:dir,log,timeoutMs:150});
 assert.equal(result.reason,'CI_TIMEOUT');assert.equal(processEvidence(result,fs.readFileSync(log,'utf8'),{requireTap:true}).status,'failed');
});
test('Real wallet CLI rejects filtering before launching any wallet test',()=>{
 const r=spawnSync(process.execPath,['wallet/test/run.mjs','--test-name-pattern','nothing'],{cwd:ROOT,encoding:'utf8',timeout:3000});
 assert.equal(r.status,1);assert.match(r.stderr,/WALLET_TEST_ARGUMENTS/);assert.equal(r.stdout,'');
});
test('Three real files never exceed the configured two-file cap',t=>{
 const source=name=>`import test from 'node:test';import fs from 'node:fs';test('${name}',async()=>{fs.appendFileSync('events.jsonl',JSON.stringify({name:'${name}',event:'start',pid:process.pid})+'\\n');await new Promise(r=>setTimeout(r,120));fs.appendFileSync('events.jsonl',JSON.stringify({name:'${name}',event:'end',pid:process.pid})+'\\n');});`;
 const dir=fixture(t,Object.fromEntries(['a','b','c'].map(name=>[name+'.test.mjs',source(name)])));const r=actual(dir);assert.equal(r.status,0,r.stdout+r.stderr);
 const events=fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 let active=0,peak=0;const seen=new Set();for(const e of events){if(e.event==='start'){assert.ok(!seen.has(e.name));seen.add(e.name);active++;}else active--;peak=Math.max(peak,active);assert.ok(active>=0&&active<=2);}
 assert.equal(active,0);assert.equal(seen.size,3);assert.equal(peak,2);
});
test('A spawned worker exception is not converted to success',t=>{
 assert.throws(()=>runWalletTests(fixture(t),[],{run:()=>{throw Error('SPAWN_FIXTURE_FAILURE');},write:()=>{}}),/SPAWN_FIXTURE_FAILURE/);
});
test('A failed metadata stream prevents any test process from starting',t=>{
 let calls=0;assert.throws(()=>runWalletTests(fixture(t),[],{run:()=>{calls++;},write:()=>{throw Error('OUTPUT_CLOSED');}}),/OUTPUT_CLOSED/);assert.equal(calls,0);
});
test('Maximum child exit failure code is preserved',t=>assert.equal(runWalletTests(fixture(t),[],{run:()=>({status:255}),write:()=>{}}),255));
test('Serial mode also runs every discovered file without short-circuit after a failure',t=>{
 const r=actual(fixture(t,{'a.test.mjs':"import test from 'node:test';test('first-failure',()=>{throw Error('fixture');});",'b.test.mjs':"import test from 'node:test';test('last-success',()=>{});"}),'1');
 assert.equal(r.status,1);assert.equal(r.evidence.counts.tests,2);assert.equal(r.evidence.counts.pass,1);assert.equal(r.evidence.counts.fail,1);
});
