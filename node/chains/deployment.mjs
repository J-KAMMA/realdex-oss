// Local artifacts only. Deliberately no RPC, wallet, private key or broadcast import.
import {createHash} from 'node:crypto';
import {check,object,freeze,canonical} from './core.mjs';
import {validateProfile} from './registry.mjs';
import {keccak256,fromHex} from '../verified/keccak.mjs';
export const CONTRACTS=freeze([
 {source:'contracts/LocalSwapFactory.sol',name:'LocalSwapFactory'},
 {source:'contracts/LocalSwapPool.sol',name:'LocalSwapPool'},
 {source:'contracts/LocalSwapRouter.sol',name:'LocalSwapRouter'}]);
export const SOLC='0.8.24+commit.e11b9ed9';
const sha=s=>createHash('sha256').update(s).digest('hex');
export function makeCompilerInput(sources) {
 object(sources);check(Object.keys(sources).length===3&&CONTRACTS.every(c=>typeof sources[c.source]==='string'&&sources[c.source].length>0&&sources[c.source].length<=131072),'COMPILER_SOURCES_INVALID');
 return freeze({language:'Solidity',sources:Object.fromEntries(CONTRACTS.map(c=>[c.source,{content:sources[c.source]}])),
  settings:{optimizer:{enabled:true,runs:500},evmVersion:'paris',outputSelection:{'*':{'*':['abi','metadata','evm.bytecode','evm.deployedBytecode']}}}});
}
export function planEvmDeployment(profile,input) {
 const p=validateProfile(profile);check(p.family==='evm','EVM_PLAN_REQUIRED');check(p.status!=='deprecated','CHAIN_DEPRECATED');
 // Rebuild the input to reject hidden import URLs, libraries, settings or source overrides.
 object(input);const expected=makeCompilerInput(Object.fromEntries(CONTRACTS.map(c=>[c.source,input.sources?.[c.source]?.content])));
 check(canonical(input)===canonical(expected),'COMPILER_INPUT_MISMATCH');
 const digest=sha(canonical(input));
 return freeze({schema:'realdex.evm-network-plan.v1',network:{id:p.id,name:p.name,environment:p.environment},
  sourceBundleSha256:digest,compiler:{version:SOLC,optimizerRuns:500,evmVersion:'paris',inputSha256:digest},
  status:'planning-only',toolchain:p.toolchain,compilerInputPath:'compiler-input.json',
  stages:[{operation:'deploy-factory',contract:'LocalSwapFactory',constructorArguments:[]},
   {operation:'deploy-router',contract:'LocalSwapRouter',constructorArguments:[]},
   {operation:'create-pool-after-independent-review',contract:'LocalSwapFactory',method:'createPool(address,address,uint256)',arguments:null}],
  addresses:{factory:null,router:null},runtimeCodeHashes:null,
  required:['compile with the exact compiler and compare independent outputs','review network EVM opcodes, deployment size limits and gas model','verify Factory storage/provenance, Pool constructor arguments and immutable runtime','obtain separate authorization for the exact network, artifacts and expenditure','two-reader deployment receipt/runtime checks','token behavior, swap, revert and recovery tests'],
  warnings:["Paris output has different identities from the previous default compiler target; never reuse old runtime hashes.",...(p.toolchain==='special-review'?['A network-specific toolchain or privacy/VM integration may be needed; generic solc output is not approved.']:[])],
  compiled:false,deployed:false,poolsCreated:false,authorized:false,executable:false});
}
/** Structural review of local compiler output. This is NOT a signed compiler
 * attestation or semantic proof. Untrusted compiler output cannot authorize funds. */
export function inspectCompilerOutput(input,output) {
 object(output);check(Array.isArray(output.errors??[])&&(output.errors??[]).every(e=>e.severity!=='error'),'SOLIDITY_COMPILATION_FAILED');
 const base=makeCompilerInput(Object.fromEntries(CONTRACTS.map(c=>[c.source,input.sources?.[c.source]?.content])));
 check(canonical(base)===canonical(input),'COMPILER_INPUT_MISMATCH');
 const artifacts=CONTRACTS.map(c=>{
  const x=object(output.contracts?.[c.source]?.[c.name],'CONTRACT_OUTPUT_MISSING');check(Array.isArray(x.abi),'ABI_MISSING');
  const creation=x.evm?.bytecode,runtime=x.evm?.deployedBytecode;
  for(const b of [creation,runtime])check(b&&typeof b.object==='string'&&/^(?:[0-9a-fA-F]{2})+$/.test(b.object)&&Object.keys(b.linkReferences??{}).length===0,'BYTECODE_INVALID_OR_UNLINKED');
  check(runtime.object.length/2<=24576&&creation.object.length/2<=49152,'BYTECODE_SIZE_REVIEW_REQUIRED');
  let metadata;try{metadata=JSON.parse(x.metadata);}catch{throw new Error('METADATA_INVALID');}
  check(metadata.compiler?.version===SOLC,'COMPILER_VERSION_MISMATCH');
  check(metadata.settings?.evmVersion==='paris'&&metadata.settings?.optimizer?.enabled===true&&metadata.settings.optimizer.runs===500,'COMPILER_SETTINGS_MISMATCH');
  check(metadata.settings?.compilationTarget?.[c.source]===c.name,'COMPILER_TARGET_MISMATCH');
  for(const [source,record]of Object.entries(metadata.sources??{})){
   check(Object.hasOwn(input.sources,source),'METADATA_SOURCE_UNKNOWN');
   check(record.keccak256===keccak256(new TextEncoder().encode(input.sources[source].content)),'METADATA_SOURCE_HASH_MISMATCH');
  }
  check(Object.hasOwn(metadata.sources??{},c.source),'METADATA_SOURCE_MISSING');
  return {source:c.source,name:c.name,creationBytes:creation.object.length/2,runtimeBytes:runtime.object.length/2,
   creationCodeHash:keccak256(fromHex('0x'+creation.object)),runtimeTemplateHash:keccak256(fromHex('0x'+runtime.object)),
   immutableReferences:runtime.immutableReferences??{},compilerAuthenticityVerified:false};
 });
 return freeze({schema:'realdex.evm-compiler-inspection.v1',inputSha256:sha(canonical(input)),compiler:SOLC,artifacts,
  structuralChecksPassed:true,compilerAuthenticityVerified:false,semanticEquivalenceProven:false,deploymentAuthorized:false,executable:false});
}
