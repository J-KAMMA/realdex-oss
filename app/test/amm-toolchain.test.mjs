import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {compilerProfileStatus} from '../../integration/amm/profile.mjs';
import {parseArguments,runAmm} from '../../integration/amm/run.mjs';
import {sourceSnapshot} from '../lib/acceptance.mjs';
import {compileProbe} from '../../integration/amm/compiler.mjs';
import pin from '../../integration/amm/experimental-pin.json' with {type:'json'};
import baseline from '../../integration/compiler-pin.cjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'realdex-amm-tools-'));
test('Nightly is explicitly experimental; baseline remains immutable 0.8.24',()=>{
 assert.equal(pin.experimentalOnly,true);assert.equal(pin.satisfiesPinnedProductionCompilerGate,false);assert.equal(baseline.PIN.version,'0.8.24');
 assert.equal(compilerProfileStatus('experimental').available,false);assert.equal(compilerProfileStatus('pinned').available,false);
 assert.throws(()=>compilerProfileStatus('auto'),/PROFILE_INVALID/);assert.throws(()=>compileProbe({profile:'latest'}),/PROFILE_INVALID/);
});
test('The AMM runner defaults to the pinned profile, not an ambient or automatic nightly',()=>{
 assert.equal(parseArguments(['--output','test-output']).profile,'pinned');assert.equal(parseArguments(['--output','test-output','--profile','experimental']).profile,'experimental');
 for(const a of [[],['--output',''],['--profile','experimental'],['--output','x','--fallback','experimental'],['--output','x','--profile','latest'],['--output','x','--profile','experimental','--extra']])assert.throws(()=>parseArguments(a));
});
test('Missing AMM tools produce blocked evidence; evidence cannot be overwritten',()=>{
 const d=temp(),out=path.join(d,'proof');try{const r=runAmm({output:out,profile:'experimental'});
  assert.equal(r.status,'blocked');assert.equal(r.solidityCompiled,false);assert.equal(r.allEvmScenariosPassed,false);assert.equal(r.baselineCompilerGateSatisfied,false);assert.equal(r.productionReady,false);
  const old=fs.readFileSync(path.join(out,'amm.json'));assert.throws(()=>runAmm({output:out}),/OUTPUT_ALREADY_EXISTS/);assert.deepEqual(fs.readFileSync(path.join(out,'amm.json')),old);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('Same-size forged JS compiler is rejected by digest before any code executes',()=>{
 const d=temp();try{const file=path.join(d,'compiler.cjs'),marker=path.join(d,'executed');const payload=Buffer.alloc(pin.bytes,32);Buffer.from(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'BAD');`).copy(payload);fs.writeFileSync(file,payload,{mode:0o600});
  assert.equal(compilerProfileStatus('experimental',file).reason,'EXPERIMENTAL_COMPILER_HASH_MISMATCH');
  const p=spawnSync(process.execPath,['integration/amm/compile-worker.cjs',file],{input:'{}',encoding:'utf8',env:{PATH:process.env.PATH},timeout:10000});
  assert.equal(p.status,2);assert.match(p.stderr,/COMPILER_HASH_MISMATCH/);assert.equal(fs.existsSync(marker),false);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
for(const mode of ['symlink','hardlink','group-writable','directory'])test('Experimental compiler rejects '+mode,()=>{
 const d=temp();try{const file=path.join(d,'compiler.cjs');if(mode==='directory')fs.mkdirSync(file);else{fs.writeFileSync(file,Buffer.alloc(pin.bytes),{mode:0o600});
  if(mode==='symlink'){fs.renameSync(file,file+'.target');fs.symlinkSync(file+'.target',file);}if(mode==='hardlink')fs.linkSync(file,file+'.link');if(mode==='group-writable')fs.chmodSync(file,0o660);}
  assert.equal(compilerProfileStatus('experimental',file).available,false);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('Auxiliary compiler pins and runner sources are included in source-stability evidence',()=>{
 const d=temp();try{fs.mkdirSync(path.join(d,'integration/amm'),{recursive:true});const p=path.join(d,'integration/amm/experimental-pin.json');fs.writeFileSync(p,JSON.stringify(pin));const old=sourceSnapshot(d).digest;fs.writeFileSync(p,JSON.stringify({...pin,sha256:'0'.repeat(64)}));assert.notEqual(sourceSnapshot(d).digest,old);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('Experimental compiler is not loaded merely by importing the runner',()=>{
 const d=temp();try{const marker=path.join(d,'loaded'),file=path.join(d,'evil.cjs');fs.writeFileSync(file,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'BAD')`);
  const p=spawnSync(process.execPath,['--input-type=module','-e',"import './integration/amm/run.mjs'"],{encoding:'utf8',env:{PATH:process.env.PATH,REALDEX_AMM_PROFILE:'experimental',REALDEX_EXPERIMENTAL_SOLJSON:file},timeout:10000});assert.equal(p.status,0);assert.equal(fs.existsSync(marker),false);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
