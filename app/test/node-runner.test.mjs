import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {processEvidence} from '../lib/acceptance.mjs';
import {testEnvironment} from '../lib/parallel-process.mjs';

const source = fileURLToPath(new URL('../../node/test/run-tests.mjs', import.meta.url));
function fixture(t, files = {'one.test.mjs': "import test from 'node:test'; test('fixture',()=>{});\n"}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'realdex runner '));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const directory = path.join(root, 'node/test');
  fs.mkdirSync(directory, {recursive:true});
  const runner = path.join(directory, 'run-tests.mjs');
  fs.copyFileSync(source, runner);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  fs.mkdirSync(path.join(root,'scripts'));
  fs.writeFileSync(path.join(root,'scripts/createEvmTestnetReleasePlan.test.mjs'), "import test from 'node:test'; test('release fixture',()=>{});\n");
  const probe = path.join(root,'probe.cjs');
  fs.writeFileSync(probe, `const cp=require('node:child_process');
    cp.spawnSync=(command,args,options)=>{console.log(JSON.stringify({command,args,options}));return {status:0};};
    require('node:module').syncBuiltinESMExports();\n`);
  return {root, runner, probe};
}
function invoke(f, args = [], probe = false) {
  return spawnSync(process.execPath, [...(probe?['--require',f.probe]:[]),f.runner,...args], {
    cwd:f.root, env:testEnvironment(), encoding:'utf8', timeout:15000, maxBuffer:1048576, shell:false
  });
}
for (const args of [[], ['--verified-only'], ['--with-release'], ['--verified-only','--with-release']]) {
  test('Node runner always pins TAP and bounded concurrency: '+JSON.stringify(args), t => {
    const f=fixture(t, {'z.test.mjs':'','verified-b.test.mjs':'','verified-a.test.mjs':'','ignored.mjs':''});
    const result=invoke(f,args,true);
    assert.equal(result.status,0,result.stderr);
    const call=JSON.parse(result.stdout);
    assert.equal(call.command,process.execPath);
    assert.deepEqual(call.args.slice(0,3),['--test','--test-concurrency=1','--test-reporter=tap']);
    const names=args.includes('--verified-only')?['verified-a.test.mjs','verified-b.test.mjs']:['verified-a.test.mjs','verified-b.test.mjs','z.test.mjs'];
    const expected=names.map(n=>path.join(f.root,'node/test',n));
    if(args.includes('--with-release')) expected.push(path.join(f.root,'scripts/createEvmTestnetReleasePlan.test.mjs'));
    assert.deepEqual(call.args.slice(3),expected);
    assert.deepEqual(call.options,{cwd:f.root,stdio:'inherit',shell:false});
  });
}
for (const [kind, body, status, accepted] of [
  ['pass',"test('fixture',()=>{});",0,true],
  ['failure',"test('fixture',()=>{throw Error('fixture failure')});",1,false],
  ['skip',"test('fixture',{skip:true},()=>{});",0,false],
  ['todo',"test('fixture',{todo:true},()=>{});",0,false]
]) {
  test('Real runner produces complete TAP and preserves '+kind+' outcome', t => {
    const f=fixture(t, {'one.test.mjs':"import test from 'node:test'; "+body});
    const result=invoke(f);
    assert.equal(result.status,status,result.stderr);
    assert.match(result.stdout,/^TAP version 13\r?$/m);
    const evidence=processEvidence(result,result.stdout,{requireTap:true});
    assert.equal(evidence.counts.tests,1);
    assert.equal(evidence.status,accepted?'passed':'failed');
    if(kind==='skip')assert.equal(evidence.counts.skipped,1);
    if(kind==='todo')assert.equal(evidence.counts.todo,1);
    if(kind==='failure')assert.equal(evidence.counts.fail,1);
  });
}
for (const args of [['--unknown'],['--verified-only','--verified-only'],['--with-release','--with-release'],['--test-reporter=spec']]) {
  test('Node runner rejects invalid arguments before spawning: '+args.join(' '),t=>{
    const f=fixture(t),result=invoke(f,args,true);
    assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/Usage:/);
  });
}
for (const [files,args] of [[{},[]],[{},['--with-release']],[{'one.test.mjs':''},['--verified-only']],[{'one.test.mjs':''},['--verified-only','--with-release']]]) {
  test('An empty node test selection cannot trigger implicit Node discovery: '+JSON.stringify(args),t=>{
    const f=fixture(t,files),result=invoke(f,args,true);
    assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/TEST_DISCOVERY_EMPTY/);
  });
}
test('Human-readable spec counts remain unacceptable as machine evidence',()=>{
  const spec='ℹ tests 1171\nℹ pass 1171\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n';
  assert.equal(processEvidence({status:0},spec,{requireTap:true}).status,'failed');
});
