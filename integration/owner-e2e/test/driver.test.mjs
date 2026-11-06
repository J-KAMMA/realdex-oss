import test from 'node:test';import assert from 'node:assert/strict';import {PipeDriver} from '../drivers.mjs';
function processDriver(code,options={}){return new PipeDriver({command:process.execPath,args:['--input-type=module','-e',code],timeoutMs:1000,...options});}
const listen="import readline from 'node:readline';const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);";
test('Real child frames resolve exactly one matching request',async()=>{const p=processDriver(listen+"console.log(JSON.stringify({id:m.id,ok:true,data:{received:true}}));});");try{assert.deepEqual(await p.send('probe',{}),{received:true});}finally{await p.close();}});
for(const [name,code,pattern] of [
 ['exit nonzero',"process.exit(9)",/CHILD_EXIT/],['missing result',"process.exit(0)",/CHILD_EXIT/],
 ['broken JSON',listen+"console.log('{broken');});",/CHILD_JSON/],
 ['missing payload',listen+"console.log(JSON.stringify({id:m.id,ok:true}));});",/CHILD_FRAME/],
 ['wrong id',listen+"console.log(JSON.stringify({id:m.id+1,ok:true,data:{}}));});",/CHILD_FRAME/],
 ['unknown field',listen+"console.log(JSON.stringify({id:m.id,ok:true,data:{},secret:'x'}));});",/CHILD_FRAME/],
 ['duplicate json key',listen+"console.log('{\"id\":1,\"ok\":true,\"ok\":false,\"data\":{}}');});",/CHILD_JSON/],
 ['raw error suppressed',listen+"console.log(JSON.stringify({id:m.id,ok:false,error:'https://site/?capability=secret'}));});",/^Error: E2E_BROWSER_FAILED$/],
 ['policy block distinct',listen+"console.log(JSON.stringify({id:m.id,ok:false,error:'E2E_BROWSER_POLICY_BLOCK'}));});",/BROWSER_POLICY_BLOCK/],
 ['oversize stdout',listen+"console.log('a'.repeat(2000000));});",/OUTPUT_LIMIT/],
 ['oversize stderr',listen+"process.stderr.write('a'.repeat(2000000));});",/OUTPUT_LIMIT/],
 ['signal',listen+"process.kill(process.pid,'SIGTERM');});",/CHILD_EXIT/]
])test('Real child negative: '+name,async()=>{const p=processDriver(code);try{await assert.rejects(p.send('probe',{}),pattern);}finally{await p.close();}});
test('Hung child is killed after deadline and cannot report pass',async()=>{const p=processDriver('setInterval(()=>{},10000)',{timeoutMs:80});try{await assert.rejects(p.send('probe',{}),/TIMEOUT/);}finally{await p.close();}assert.ok(p.exit);});
test('Concurrent requests are rejected without replacing pending request',async()=>{const p=processDriver(listen+"setTimeout(()=>console.log(JSON.stringify({id:m.id,ok:true,data:1})),60);});");try{const first=p.send('one',{});await assert.rejects(p.send('two',{}),/BUSY/);assert.equal(await first,1);}finally{await p.close();}});
test('Duplicate response cannot be reused for the next request',async()=>{const p=processDriver(listen+"const s=JSON.stringify({id:m.id,ok:true,data:1});console.log(s+'\\n'+s);});");try{await p.send('one',{});await new Promise(r=>setTimeout(r,20));await assert.rejects(p.send('two',{}),/FRAME/);}finally{await p.close();}});
test('Missing executable is a failed spawn not missing optional browser',async()=>{const p=new PipeDriver({command:'/not/an/executable',args:[]});try{await assert.rejects(p.send('one',{}),/CHILD_SPAWN|STDIN/);}finally{await p.close();}});

test('Successful response followed by nonzero exit still fails clean completion',async()=>{const p=processDriver(listen+"console.log(JSON.stringify({id:m.id,ok:true,data:1}));process.exitCode=7;lines.close();});");await p.send('one',{});await assert.rejects(p.close(),/CHILD_EXIT|CHILD_CLOSE_FAILED/);});
