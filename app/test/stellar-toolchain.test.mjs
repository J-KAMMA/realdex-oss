import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {stellarQuickstartStatus,validateStellarQuickstartPin,STELLAR_QUICKSTART_PIN} from '../../integration/stellar/toolchain.mjs';
import {sourceSnapshot,acceptancePassed,ACCOUNT_RUNTIME_GATES} from '../lib/acceptance.mjs';

test('Stellar real runtime needs a full immutable digest AND a configured container runtime',()=>{
  // The digest is pinned now, so the remaining precondition is the runtime itself.
  assert.match(STELLAR_QUICKSTART_PIN.quickstartImageDigest,/^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(stellarQuickstartStatus(),{available:false,reason:'STELLAR_CONTAINER_RUNTIME_NOT_CONFIGURED',executed:false});
  assert.equal(STELLAR_QUICKSTART_PIN.testOnly,true);assert.equal(STELLAR_QUICKSTART_PIN.publicNetworkAllowed,false);assert.equal(STELLAR_QUICKSTART_PIN.autoPullAllowed,false);
});
test('An unpinned digest still blocks the Stellar runtime, whatever runtime is supplied',()=>{
  const unpinned={...STELLAR_QUICKSTART_PIN,quickstartImageDigest:null};
  assert.throws(()=>stellarQuickstartRunPlan({pin:unpinned}),/STELLAR_QUICKSTART_IMAGE_DIGEST_NOT_PINNED/);
});
test('Stellar pin rejects truncated digests, moving tags, public-network policy, and passphrase changes',()=>{
  for(const patch of [
    {quickstartImageDigest:'sha256:1234'},
    {quickstartImage:'stellar/quickstart:latest'},
    {publicNetworkAllowed:true},
    {networkPassphrase:'Public Global Stellar Network ; September 2015'}
  ])assert.throws(()=>validateStellarQuickstartPin({...STELLAR_QUICKSTART_PIN,...patch}),/STELLAR_/);
});
test('Stellar preflight never executes the supplied container runtime',()=>{
  // Preflight inspects the binary and must not run it. Only StellarRuntime.test.mjs runs it.
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'stellar-preflight-'));try{
    const marker=path.join(d,'marker'),fake=path.join(d,'runtime');fs.writeFileSync(fake,'#!/bin/sh\ntouch "'+marker+'"\n',{mode:0o700});
    const status=stellarQuickstartStatus(fake);
    assert.equal(status.available,true);assert.equal(status.executed,false);
    assert.equal(fs.existsSync(marker),false,'preflight must not execute the runtime');
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('Stellar source pin participates in the acceptance source digest',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'stellar-source-'));try{
    fs.mkdirSync(path.join(d,'integration/stellar'),{recursive:true});const f=path.join(d,'integration/stellar/pin.json');fs.writeFileSync(f,JSON.stringify(STELLAR_QUICKSTART_PIN));const before=sourceSnapshot(d);
    fs.writeFileSync(f,JSON.stringify({...STELLAR_QUICKSTART_PIN,protocolVersion:29}));assert.notEqual(sourceSnapshot(d).digest,before.digest);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('Acceptance rejects duplicate Stellar requests before writing evidence',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'stellar-flags-'));try{const out=path.join(d,'result'),r=spawnSync(process.execPath,['app/verify.mjs','--stellar','--stellar','--output',out],{encoding:'utf8'});assert.equal(r.status,1);assert.equal(fs.existsSync(out),false);}finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('Synthetic wallet coverage cannot satisfy the Stellar native runtime gate',()=>{
  assert.equal(acceptancePassed([{name:'stellar-core-runtime',status:'blocked'},{name:'aptos-local-runtime',status:'passed'}],ACCOUNT_RUNTIME_GATES),false);
});
import {stellarQuickstartRunPlan} from '../../integration/stellar/runtime-plan.mjs';
const completePin={...STELLAR_QUICKSTART_PIN,quickstartImageDigest:'sha256:'+'a'.repeat(64)};
test('Stellar Quickstart run plan is loopback-only, local-only, digest-bound and ephemeral',()=>{
  const plan=stellarQuickstartRunPlan({pin:completePin,name:'realdex-stellar-test',hostPort:18000});
  assert.equal(plan.image,STELLAR_QUICKSTART_PIN.quickstartImage+'@sha256:'+'a'.repeat(64));
  assert.equal(plan.horizonUrl,'http://127.0.0.1:18000/');assert.equal(plan.networkPassphrase,'Standalone Network ; February 2017');
  assert.deepEqual(plan.runArgs.slice(-7),['--local','--protocol-version','28','--enable','core,horizon','--core-log-level','WARNING']);
  const text=JSON.stringify(plan);assert.equal(text.includes('--pubnet'),false);assert.equal(text.includes('--testnet'),false);assert.equal(text.includes('0.0.0.0'),false);assert.equal(text.includes(' pull '),false);assert.equal(text.includes('--volume'),false);
  assert.deepEqual(plan.coreVersionArgs,['exec','realdex-stellar-test','stellar-core','version']);
  assert.deepEqual(plan.horizonVersionArgs,['exec','realdex-stellar-test','stellar-horizon','version']);
});
test('Stellar Quickstart run plan refuses missing digest, privileged port, and unsafe container name',()=>{
  assert.throws(()=>stellarQuickstartRunPlan({pin:{...STELLAR_QUICKSTART_PIN,quickstartImageDigest:null}}),/STELLAR_QUICKSTART_IMAGE_DIGEST_NOT_PINNED/);
  assert.throws(()=>stellarQuickstartRunPlan({pin:completePin,hostPort:80}),/STELLAR_HOST_PORT_INVALID/);
  assert.throws(()=>stellarQuickstartRunPlan({pin:completePin,name:'../../oops'}),/STELLAR_CONTAINER_NAME_INVALID/);
});
