import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import candidate from '../../wallet/smart-account/stable-build-candidate.json' with {type:'json'};
import experimental from '../../wallet/smart-account/build.json' with {type:'json'};
import evidence from '../../integration/smart-account/stable-candidate-evidence.json' with {type:'json'};
import {verifyCandidate,candidateFromBuildInfo} from '../../integration/smart-account/stable-candidate.mjs';
import {compilerInput} from '../../integration/compile-local.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
test('stable smart-account candidate remains source-bound and explicitly unapproved',()=>{
  assert.equal(verifyCandidate(candidate,{root:ROOT,expectedBuildInfoSha256:evidence.buildInfoSha256}),true);
  assert.equal(candidate.productionApproved,false);assert.equal(candidate.independentReviewComplete,false);assert.equal(candidate.compilerExecutionReplayed,false);
});
test('stable candidate provenance binds pinned compiler, build-info, and compact compiler input',()=>{
  assert.equal(candidate.compiler,evidence.compiler);assert.equal(candidate.compilerSha256,evidence.compilerSha256);
  assert.equal(candidate.buildInfoSha256,evidence.buildInfoSha256);assert.equal(candidate.inputSha256,evidence.inputSha256);
  assert.equal(sha(fs.readFileSync(path.join(ROOT,'wallet/smart-account/stable-build-candidate.json'))),evidence.candidateSha256);
});
test('stable and experimental smart artifacts keep the same ABI but not the same bytecode identity',()=>{
  for(const name of ['RealDexSmartAccount','RealDexSmartAccountFactory']){
    assert.deepEqual(candidate.contracts[name].abi,experimental.contracts[name].abi);
    assert.notEqual(candidate.contracts[name].creationCode,experimental.contracts[name].creationCode);
    assert.notEqual(candidate.contracts[name].runtimeTemplate,experimental.contracts[name].runtimeTemplate);
  }
});
test('candidate source hashes are recomputed independently from current bytes',()=>{
  for(const [file,digest] of Object.entries(candidate.sourceHashes))assert.equal(sha(fs.readFileSync(path.join(ROOT,file))),digest);
});
test('stable account immutable map is exactly owner and factory and all ranges fit the runtime',()=>{
  const c=candidate.contracts.RealDexSmartAccount,bytes=(c.runtimeTemplate.length-2)/2;
  assert.deepEqual(Object.keys(c.immutableReferences).sort(),['factory','owner']);
  for(const refs of Object.values(c.immutableReferences))for(const r of refs){assert.equal(r.length,32);assert.ok(r.start>=0&&r.start+r.length<=bytes);}
  assert.deepEqual(candidate.contracts.RealDexSmartAccountFactory.immutableReferences,{});
});
test('candidate metadata never converts compiler evidence into release approval',()=>{
  assert.equal(candidate.stableCompilerIdentity,true);assert.equal(candidate.compilerExecutionReplayed,false);
  assert.equal(candidate.independentReviewComplete,false);assert.equal(candidate.productionApproved,false);
  assert.equal(evidence.productionApproved,false);
});

function syntheticBuildInfo(){
  const input=compilerInput(ROOT),contracts={},sources={};
  for(const [source,name] of [['contracts/smart/RealDexSmartAccount.sol','RealDexSmartAccount'],['contracts/smart/RealDexSmartAccountFactory.sol','RealDexSmartAccountFactory']]){
    const c=candidate.contracts[name],ids=name==='RealDexSmartAccount'?{owner:'101',factory:'102'}:{};
    const refs=Object.fromEntries(Object.entries(c.immutableReferences).map(([key,value])=>[ids[key],value]));
    contracts[source]={[name]:{abi:c.abi,evm:{bytecode:{object:c.creationCode.slice(2)},deployedBytecode:{object:c.runtimeTemplate.slice(2),immutableReferences:refs}}}};
    sources[source]={ast:{nodes:[{nodeType:'ContractDefinition',name,nodes:Object.entries(ids).map(([n,id])=>({nodeType:'VariableDeclaration',id:Number(id),name:n,mutability:'immutable'}))}]}};
  }
  return {solcVersion:'0.8.24',solcLongVersion:'0.8.24+commit.e11b9ed9',input,output:{contracts,sources,errors:[]}};
}
function importSynthetic(build){const bytes=Buffer.from(JSON.stringify(build)),digest=sha(bytes);return candidateFromBuildInfo({bytes,expectedSha256:digest,root:ROOT});}
test('stable importer reconstructs the committed candidate contract payload from pinned-shape build-info',()=>{
  const imported=importSynthetic(syntheticBuildInfo());assert.deepEqual(imported.contracts,candidate.contracts);assert.deepEqual(imported.sourceHashes,candidate.sourceHashes);assert.deepEqual(imported.settings,candidate.settings);
});
test('stable importer rejects a matching-hash build-info that claims another compiler version',()=>{
  const build=syntheticBuildInfo();build.solcLongVersion='0.8.25+commit.deadbeef';assert.throws(()=>importSynthetic(build),/SMART_STABLE_COMPILER_VERSION_MISMATCH/);
});
test('stable importer rejects a matching-hash build-info whose compiler input differs from current source',()=>{
  const build=syntheticBuildInfo();build.input.sources['contracts/smart/RealDexSmartAccount.sol'].content+='\n';assert.throws(()=>importSynthetic(build),/SMART_STABLE_INPUT_MISMATCH/);
});
test('stable importer rejects compiler output carrying a compilation error',()=>{
  const build=syntheticBuildInfo();build.output.errors=[{severity:'error'}];assert.throws(()=>importSynthetic(build),/SMART_STABLE_COMPILATION_ERROR/);
});
test('stable importer rejects a build-info whose bytes do not match the externally expected digest',()=>{
  const bytes=Buffer.from(JSON.stringify(syntheticBuildInfo()));assert.throws(()=>candidateFromBuildInfo({bytes,expectedSha256:'0'.repeat(64),root:ROOT}),/SMART_STABLE_BUILD_INFO_HASH_MISMATCH/);
});
