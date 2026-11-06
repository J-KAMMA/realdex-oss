import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {processEvidence,acceptancePassed,sourceSnapshot} from '../lib/acceptance.mjs';
import {compilerInput} from '../../integration/compile-local.mjs';
import pin from '../../integration/compiler-pin.cjs';
const pass={status:0,signal:null};
const tap='# tests 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
for(const [name,result,log] of [
 ['empty output',pass,''],['zero tests',pass,tap.replaceAll('4','0')],
 ['skipped test',pass,tap.replace('# pass 4','# pass 3').replace('# skipped 0','# skipped 1')],
 ['cancelled test',pass,tap.replace('# cancelled 0','# cancelled 1')],
 ['TODO test',pass,tap.replace('# todo 0','# todo 1')],
 ['signal termination',{status:0,signal:'SIGTERM'},tap],
 ['spawn error',{status:0,error:Error('spawn failed')},tap],['nonzero exit',{status:1},tap],
])test(`Acceptance cannot promote ${name}`,()=>assert.equal(processEvidence(result,log,{requireTap:true}).status,'failed'));
test('A genuine nonempty clean TAP exit is accepted',()=>assert.equal(processEvidence(pass,tap,{requireTap:true}).status,'passed'));
test('Non-TAP build gates use exit status without pretending to count tests',()=>{const r=processEvidence(pass,'compiled');assert.equal(r.status,'passed');assert.equal(r.counts,undefined);});
for(const status of ['blocked','not-run','failed','skipped'])test(`Full gate decision refuses ${status}`,()=>assert.equal(acceptancePassed([{name:'a',status}],['a']),false));
test('Missing, duplicate and empty gate sets cannot pass',()=>{
 assert.equal(acceptancePassed([],[]),false);assert.equal(acceptancePassed([{name:'b',status:'passed'}],['a']),false);
 assert.equal(acceptancePassed([{name:'a',status:'passed'},{name:'a',status:'passed'}],['a']),false);
 assert.equal(acceptancePassed([{name:'a',status:'passed'}],['a','a']),false);
 assert.equal(acceptancePassed([{name:'a',status:'passed'}],['a']),true);
});
function tree(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-source-test-'));fs.mkdirSync(path.join(root,'wallet'));fs.writeFileSync(path.join(root,'wallet','example.mjs'),'export const a=1;');fs.writeFileSync(path.join(root,'package.json'),'{}');return root;}
test('Source snapshot changes on code or lockfile changes, not historical evidence',()=>{
 const root=tree();try{
 const a=sourceSnapshot(root);fs.mkdirSync(path.join(root,'wallet/evidence'));fs.writeFileSync(path.join(root,'wallet/evidence','ignored.json'),'{}');
 assert.deepEqual(sourceSnapshot(root),a);
 fs.writeFileSync(path.join(root,'wallet','example.mjs'),'export const a=2;');assert.notEqual(sourceSnapshot(root).digest,a.digest);
 const b=sourceSnapshot(root);fs.writeFileSync(path.join(root,'pnpm-lock.yaml'),'lockfileVersion: 9');assert.notEqual(sourceSnapshot(root).digest,b.digest);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Source snapshot rejects live and dangling symlinks without reading their targets',()=>{
 const root=tree();try{
 const p=path.join(root,'wallet','injected.mjs');fs.symlinkSync('/missing-realdex-test-target',p);assert.throws(()=>sourceSnapshot(root),/SOURCE_SYMLINK/);
 fs.unlinkSync(p);fs.symlinkSync(path.join(root,'package.json'),p);assert.throws(()=>sourceSnapshot(root),/SOURCE_SYMLINK/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Selected sources exclude private root .env and explicitly excluded output directory',()=>{
 const root=tree();try{
 const before=sourceSnapshot(root);fs.writeFileSync(path.join(root,'.env'),'FAKE_PRIVATE_TEST=hidden');
 const output=path.join(root,'wallet','generated');fs.mkdirSync(output);fs.writeFileSync(path.join(output,'new.json'),'{}');
 assert.equal(sourceSnapshot(root,{exclude:[output]}).digest,before.digest);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Compiler identity is pinned to original version, absent compiler does not fall back to downloads',()=>{
 assert.equal(pin.PIN.version,'0.8.24');assert.equal(pin.compilerStatus().available,false);
 assert.equal(pin.compilerStatus().reason,'LOCAL_COMPILER_NOT_CONFIGURED');
 const root=tree();try{const file=path.join(root,'fake-solc');fs.writeFileSync(file,'fake');fs.chmodSync(file,0o500);assert.equal(pin.compilerStatus(file).available,false);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Compiler input includes exact delivered Solidity sources and explicit optimizer/target',()=>{
 const input=compilerInput();assert.equal(Object.keys(input.sources).length,8);assert.equal(input.settings.optimizer.runs,500);assert.equal(input.settings.evmVersion,'shanghai');
 assert.ok(input.sources['contracts/LocalSwapFactory.sol'].content.includes('LocalSwapFactory'));
 assert.ok(input.sources['contracts/smart/RealDexSmartAccount.sol'].content.includes('isValidSignature'));
 assert.ok(input.sources['contracts/smart/RealDexSmartAccountFactory.sol'].content.includes('createAccount'));
 assert.deepEqual(compilerInput(),input);
});

test('Root launcher, alternate Hardhat config and browser requirements are source-bound',()=>{
 const root=tree();try{
 for(const file of ['start-realdex.cmd','hardhat.v01-test.config.cjs','integration/browser-requirements.txt']){
  const before=sourceSnapshot(root).digest;const dest=path.join(root,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,'changed test fixture');
  assert.notEqual(sourceSnapshot(root).digest,before);
 }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('A same-size executable with a wrong compiler hash is rejected without execution',()=>{
 const root=tree();try{
 const file=path.join(root,'fake-solc');const fd=fs.openSync(file,'wx',0o600);fs.ftruncateSync(fd,pin.PIN.bytes);fs.closeSync(fd);fs.chmodSync(file,0o500);
 const status=pin.compilerStatus(file);assert.equal(status.available,false);assert.equal(status.compilerExecuted,false);
 assert.equal(status.reason,process.platform==='linux'&&process.arch==='x64'?'LOCAL_COMPILER_HASH_MISMATCH':'LOCAL_COMPILER_PLATFORM_UNSUPPORTED');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
