#!/usr/bin/env node
/**
 * Import a pinned-solc build-info file into a non-production smart-account
 * candidate. This tool does not trust an arbitrary build-info file: callers
 * must supply its expected SHA-256 and the embedded compiler input must match
 * the current source tree exactly.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {compilerInput} from '../compile-local.mjs';
import {compileProbe} from '../amm/compiler.mjs';
import stable from '../compiler-pin.cjs';
import {canonical,need,safeError} from '../../wallet/lib/guard.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const SMART=Object.freeze([
  ['contracts/smart/RealDexSmartAccount.sol','RealDexSmartAccount'],
  ['contracts/smart/RealDexSmartAccountFactory.sol','RealDexSmartAccountFactory'],
]);
function smartContract(output,source,name){
  const c=output?.contracts?.[source]?.[name],ast=output?.sources?.[source]?.ast;
  need(c?.evm?.bytecode?.object&&c?.evm?.deployedBytecode?.object&&Array.isArray(c.abi)&&ast,'SMART_STABLE_CONTRACT_MISSING');
  const contract=ast.nodes?.find(n=>n.nodeType==='ContractDefinition'&&n.name===name);
  need(contract&&Array.isArray(contract.nodes),'SMART_STABLE_AST_MISSING');
  const immutableNames=Object.fromEntries(contract.nodes.filter(n=>n.nodeType==='VariableDeclaration'&&n.mutability==='immutable').map(n=>[String(n.id),n.name]));
  const rawRefs=c.evm.deployedBytecode.immutableReferences??{},immutableReferences={};
  for(const [id,refs] of Object.entries(rawRefs)){
    const immutableName=immutableNames[id];need(typeof immutableName==='string'&&immutableName.length>0,'SMART_STABLE_IMMUTABLE_UNKNOWN');
    need(Array.isArray(refs)&&refs.every(r=>Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.length)&&r.start>=0&&r.length>0),'SMART_STABLE_IMMUTABLE_RANGE_INVALID');
    immutableReferences[immutableName]=refs.map(r=>({start:r.start,length:r.length}));
  }
  return {source,abi:c.abi,creationCode:'0x'+c.evm.bytecode.object,runtimeTemplate:'0x'+c.evm.deployedBytecode.object,immutableReferences};
}
export function candidateFromBuildInfo({bytes,expectedSha256,root=ROOT}={}){
  need(Buffer.isBuffer(bytes)&&bytes.length>0,'SMART_STABLE_BUILD_INFO_REQUIRED');
  need(typeof expectedSha256==='string'&&/^[0-9a-f]{64}$/.test(expectedSha256),'SMART_STABLE_BUILD_INFO_SHA_REQUIRED');
  const buildInfoSha256=sha(bytes);need(buildInfoSha256===expectedSha256,'SMART_STABLE_BUILD_INFO_HASH_MISMATCH');
  let build;try{build=JSON.parse(bytes.toString('utf8'));}catch{throw Error('SMART_STABLE_BUILD_INFO_JSON_INVALID');}
  need(build?.solcVersion===stable.PIN.version&&build?.solcLongVersion===stable.PIN.longVersion,'SMART_STABLE_COMPILER_VERSION_MISMATCH');
  const currentInput=compilerInput(root);need(canonical(build.input)===canonical(currentInput),'SMART_STABLE_INPUT_MISMATCH');
  need(build.output&&!(build.output.errors??[]).some(e=>e?.severity==='error'),'SMART_STABLE_COMPILATION_ERROR');
  const contracts=Object.fromEntries(SMART.map(([source,name])=>[name,smartContract(build.output,source,name)]));
  const sourceHashes=Object.fromEntries(SMART.map(([source])=>[source,sha(Buffer.from(currentInput.sources[source].content))]));
  return {
    schema:'realdex.smart-account-stable-candidate.v1',
    compiler:stable.PIN.longVersion,
    compilerSha256:stable.PIN.sha256,
    buildInfoSha256,
    inputSha256:sha(Buffer.from(JSON.stringify(currentInput))),
    sourceHashes,
    settings:currentInput.settings,
    stableCompilerIdentity:true,
    compilerExecutionReplayed:false,
    independentReviewComplete:false,
    productionApproved:false,
    contracts,
  };
}
export function verifyCandidate(candidate,{root=ROOT,expectedBuildInfoSha256}={}){
  need(candidate?.schema==='realdex.smart-account-stable-candidate.v1','SMART_STABLE_CANDIDATE_SCHEMA_INVALID');
  need(candidate.compiler===stable.PIN.longVersion&&candidate.compilerSha256===stable.PIN.sha256&&candidate.stableCompilerIdentity===true,'SMART_STABLE_CANDIDATE_COMPILER_INVALID');
  need(candidate.compilerExecutionReplayed===false&&candidate.independentReviewComplete===false&&candidate.productionApproved===false,'SMART_STABLE_CANDIDATE_APPROVAL_INVALID');
  if(expectedBuildInfoSha256!==undefined)need(candidate.buildInfoSha256===expectedBuildInfoSha256,'SMART_STABLE_CANDIDATE_PROVENANCE_MISMATCH');
  const input=compilerInput(root);need(candidate.inputSha256===sha(Buffer.from(JSON.stringify(input)))&&canonical(candidate.settings)===canonical(input.settings),'SMART_STABLE_CANDIDATE_INPUT_INVALID');
  for(const [source,name] of SMART){
    need(candidate.sourceHashes?.[source]===sha(fs.readFileSync(path.join(root,source))),'SMART_STABLE_CANDIDATE_SOURCE_MISMATCH');
    const c=candidate.contracts?.[name];need(c?.source===source&&Array.isArray(c.abi)&&/^0x[0-9a-f]+$/i.test(c.creationCode)&&/^0x[0-9a-f]+$/i.test(c.runtimeTemplate),'SMART_STABLE_CANDIDATE_CONTRACT_INVALID');
    for(const refs of Object.values(c.immutableReferences??{}))need(Array.isArray(refs)&&refs.every(r=>Number.isSafeInteger(r.start)&&r.start>=0&&Number.isSafeInteger(r.length)&&r.length>0),'SMART_STABLE_CANDIDATE_IMMUTABLE_INVALID');
  }
  return true;
}
export function replayCandidate(candidate,{compiler,root=ROOT}={}){
  verifyCandidate(candidate,{root});
  const build=compileProbe({profile:'pinned',compiler,root}),input=compilerInput(root);
  need(build.solcLongVersion===stable.PIN.longVersion&&build.evidence.compilerSha256===stable.PIN.sha256,'SMART_STABLE_REPLAY_COMPILER_MISMATCH');
  const contracts=Object.fromEntries(SMART.map(([source,name])=>[name,smartContract(build.output,source,name)]));
  const sourceHashes=Object.fromEntries(SMART.map(([source])=>[source,sha(Buffer.from(input.sources[source].content))]));
  need(canonical(candidate.settings)===canonical(input.settings),'SMART_STABLE_REPLAY_SETTINGS_MISMATCH');
  need(canonical(candidate.sourceHashes)===canonical(sourceHashes),'SMART_STABLE_REPLAY_SOURCE_MISMATCH');
  need(canonical(candidate.contracts)===canonical(contracts),'SMART_STABLE_REPLAY_BYTECODE_MISMATCH');
  return {replayed:true,compiler:build.solcLongVersion,compilerSha256:build.evidence.compilerSha256,inputSha256:sha(Buffer.from(JSON.stringify(input)))};
}
function args(argv){
  const out={};for(let i=0;i<argv.length;i+=2){need(argv[i]?.startsWith('--')&&argv[i+1],'SMART_STABLE_ARGUMENTS_INVALID');out[argv[i].slice(2)]=argv[i+1];}
  need(out['build-info']&&out['expected-sha256']&&out.output,'SMART_STABLE_ARGUMENTS_INVALID');return out;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const a=args(process.argv.slice(2)),bytes=fs.readFileSync(path.resolve(a['build-info']));
    const candidate=candidateFromBuildInfo({bytes,expectedSha256:a['expected-sha256']});verifyCandidate(candidate,{expectedBuildInfoSha256:a['expected-sha256']});
    const dest=path.resolve(a.output);fs.writeFileSync(dest,JSON.stringify(candidate,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({schema:candidate.schema,output:dest,sha256:sha(fs.readFileSync(dest)),compiler:candidate.compiler,productionApproved:false}));
  }catch(e){console.error(safeError(e));process.exitCode=1;}
}
