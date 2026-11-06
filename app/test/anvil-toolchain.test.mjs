import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {anvilStatus,ANVIL_PIN} from '../../integration/anvil/toolchain.mjs';
import {sourceSnapshot} from '../lib/acceptance.mjs';
test('Real-EVM gate without explicit test executable is blocked, not silently replaced with mocks',()=>{
  assert.deepEqual(anvilStatus(),{available:false,reason:'ANVIL_NOT_CONFIGURED',executed:false});
  assert.equal(ANVIL_PIN.chainId,'31337');assert.equal(ANVIL_PIN.forTestingOnly,true);
});
test('An unknown Anvil executable is rejected without execution',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'anvil-invalid-'));
  try{const f=path.join(d,'anvil');fs.writeFileSync(f,'#!/bin/sh\ntouch '+path.join(d,'executed')+'\n',{mode:0o700});
    assert.equal(anvilStatus(f).available,false);assert.equal(fs.existsSync(path.join(d,'executed')),false);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('Anvil binary symlinks are not accepted as pinned tools',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'anvil-link-'));
  try{const f=path.join(d,'anvil');fs.symlinkSync(process.execPath,f);assert.equal(anvilStatus(f).available,false);}
  finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('The Anvil gate records blocked status when unavailable and refuses to overwrite evidence',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'anvil-cli-')),out=path.join(d,'out');
  try{
    const env={PATH:process.env.PATH,HOME:d};
    const args=['integration/anvil/run.mjs','--output',out];
    const a=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:10000});assert.equal(a.status,2);
    const file=path.join(out,'anvil-native.json'),before=fs.readFileSync(file,'utf8'),r=JSON.parse(before);
    assert.equal(r.status,'blocked');assert.equal(r.realEvmExecuted,false);assert.equal(r.publicNetworkContacted,false);
    const b=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:10000});assert.equal(b.status,1);assert.equal(fs.readFileSync(file,'utf8'),before);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('The test-tool pin is covered by source stability checks',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'anvil-source-'));fs.mkdirSync(path.join(d,'integration/anvil'),{recursive:true});
  try{const p=path.join(d,'integration/anvil/pin.json');fs.writeFileSync(p,JSON.stringify(ANVIL_PIN));const old=sourceSnapshot(d);fs.writeFileSync(p,JSON.stringify({...ANVIL_PIN,sha256:'0'.repeat(64)}));assert.notEqual(sourceSnapshot(d).digest,old.digest);}
  finally{fs.rmSync(d,{recursive:true,force:true});}
});
