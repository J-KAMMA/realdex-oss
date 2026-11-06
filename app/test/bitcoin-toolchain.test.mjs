import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {bitcoindStatus,BITCOIND_PIN} from '../../integration/bitcoin/toolchain.mjs';
import {sourceSnapshot} from '../lib/acceptance.mjs';
test('Bitcoin real-node test is unavailable without an explicitly configured pinned binary',()=>{
  assert.deepEqual(bitcoindStatus(),{available:false,reason:'BITCOIND_NOT_CONFIGURED',executed:false});assert.match(BITCOIND_PIN.scope,/Test-only/);
});
test('An arbitrary or symlinked Bitcoin binary is refused without execution',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'btc-pin-'));try{const bin=path.join(d,'fake'),marker=path.join(d,'executed');fs.writeFileSync(bin,'#!/bin/sh\ntouch '+marker,{mode:0o700});assert.equal(bitcoindStatus(bin).available,false);assert.equal(fs.existsSync(marker),false);fs.symlinkSync(process.execPath,path.join(d,'link'));assert.equal(bitcoindStatus(path.join(d,'link')).available,false);}finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('Bitcoin integration pin is included in source stability digest',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'btc-source-'));try{const dir=path.join(d,'integration/bitcoin');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'pin.json');fs.writeFileSync(file,JSON.stringify(BITCOIND_PIN));const before=sourceSnapshot(d);fs.writeFileSync(file,JSON.stringify({...BITCOIND_PIN,sha256:'0'.repeat(64)}));assert.notEqual(before.digest,sourceSnapshot(d).digest);}finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('Bitcoin configuration CLI refuses unknown flags without RPC access',()=>{
 const r=spawnSync(process.execPath,['wallet/non-evm/bitcoin-config.mjs','--private-key','must-not-be-used'],{encoding:'utf8',timeout:10000});assert.notEqual(r.status,0);assert.ok(!r.stdout.includes('must-not-be-used')&&!r.stderr.includes('must-not-be-used'));
});
test('Acceptance parser rejects duplicate explicit Bitcoin gate flags before creating output',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'btc-flags-'));try{const out=path.join(d,'result');const r=spawnSync(process.execPath,['app/verify.mjs','--bitcoin','--bitcoin','--output',out],{encoding:'utf8',timeout:10000});assert.equal(r.status,1);assert.equal(fs.existsSync(out),false);}finally{fs.rmSync(d,{recursive:true,force:true});}
});
