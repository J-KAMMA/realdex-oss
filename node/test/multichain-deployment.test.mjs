import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {registry,profile} from './multichain-fixtures.mjs';
import {CONTRACTS,SOLC,makeCompilerInput,planEvmDeployment,inspectCompilerOutput} from '../chains/deployment.mjs';
import {keccak256} from '../verified/keccak.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sources=Object.fromEntries(CONTRACTS.map(c=>[c.source,fs.readFileSync(path.join(root,c.source),'utf8')]));
const input=makeCompilerInput(sources);
for(const p of registry.list().filter(p=>p.family==='evm'))test('local EVM plan '+p.id+' cannot authorize or deploy',()=>{
 const plan=planEvmDeployment(p,input);assert.equal(plan.network.id,p.id);assert.equal(plan.compiled,false);assert.equal(plan.deployed,false);assert.equal(plan.authorized,false);assert.equal(plan.executable,false);assert.equal(plan.addresses.factory,null);assert.equal(plan.compiler.evmVersion,'paris');assert.equal(plan.stages[0].constructorArguments.length,0);
});
test('compiler input keeps exact preserved sources and selects explicit target',()=>{assert.equal(input.settings.optimizer.runs,500);assert.equal(input.settings.evmVersion,'paris');assert.equal(input.sources[CONTRACTS[0].source].content,sources[CONTRACTS[0].source]);});
test('native families cannot receive a generic EVM deployment plan',()=>assert.throws(()=>planEvmDeployment(profile('solana'),input),/EVM_PLAN_REQUIRED/));
test('compiler input rejects modified optimizer and remote source URLs',()=>{
 const other=structuredClone(input);other.settings.optimizer.runs=200;assert.throws(()=>planEvmDeployment(profile('evm'),other),/COMPILER_INPUT_MISMATCH/);
 const urls=structuredClone(input);urls.sources[CONTRACTS[0].source]={urls:['https://evil.example/Factory.sol']};assert.throws(()=>planEvmDeployment(profile('evm'),urls));
});
function syntheticOutput(){const out={contracts:{},errors:[]};for(const c of CONTRACTS){out.contracts[c.source]={[c.name]:{abi:[],metadata:JSON.stringify({compiler:{version:SOLC},settings:{evmVersion:'paris',optimizer:{enabled:true,runs:500},compilationTarget:{[c.source]:c.name}},sources:Object.fromEntries(CONTRACTS.map(z=>[z.source,{keccak256:keccak256(new TextEncoder().encode(sources[z.source]))}]))}),evm:{bytecode:{object:'6000',linkReferences:{}},deployedBytecode:{object:'00',linkReferences:{},immutableReferences:{}}}}};}return out;}
test('structural compiler inspection remains unauthenticated (synthetic compiler output)',()=>{const v=inspectCompilerOutput(input,syntheticOutput());assert(v.structuralChecksPassed);assert(!v.compilerAuthenticityVerified&&!v.semanticEquivalenceProven&&!v.executable);});
for(const defect of ['errors','bad-source-hash','wrong-compiler','unlinked','size','missing'])test('compiler inspection rejects '+defect,()=>{
 const out=syntheticOutput(),x=out.contracts[CONTRACTS[0].source][CONTRACTS[0].name];
 if(defect==='errors')out.errors=[{severity:'error'}];
 if(defect==='bad-source-hash'||defect==='wrong-compiler'){const m=JSON.parse(x.metadata);if(defect==='wrong-compiler')m.compiler.version='0.8.25';else m.sources[CONTRACTS[0].source].keccak256='0x'+'0'.repeat(64);x.metadata=JSON.stringify(m);}
 if(defect==='unlinked')x.evm.bytecode.object='__$INVALID$__';if(defect==='size')x.evm.deployedBytecode.object='00'.repeat(24577);if(defect==='missing')delete out.contracts;
 assert.throws(()=>inspectCompilerOutput(input,out));
});
function cli(args){return spawnSync(process.execPath,['node/chains.mjs',...args],{cwd:root,encoding:'utf8',timeout:20000});}
test('CLI generates every bundled EVM plan and refuses overwriting output',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-chains-')),out=path.join(dir,'plans');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const result=cli(['plans','--all','--output',out]);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).count,89);assert.equal(fs.readdirSync(out).length,91);assert.equal(cli(['plans','--all','--output',out]).status,1);
 assert.equal(fs.readFileSync(path.join(out,'compiler-input.json'),'utf8').includes('privateKey'),false);
});
test('CLI list and inspect provide stable non-executable data',()=>{
 assert.equal(JSON.parse(cli(['list']).stdout).count,138);const out=cli(['inspect','--chain','eip155:84532']);assert.equal(out.status,0);assert.equal(JSON.parse(out.stdout).capabilities.swapsExecutable,false);
});
test('CLI rejects unknown commands/flags and signing arguments',()=>{for(const args of [['deploy'],['list','--private-key','SECRET'],['plans','--all','--chain','eip155:1','--output','x']]){const r=cli(args);assert.equal(r.status,1);assert(!r.stderr.includes('SECRET'));}});
