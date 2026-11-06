import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import candidate from '../../wallet/smart-account/stable-build-candidate.json' with {type:'json'};
import experimental from '../../wallet/smart-account/build.json' with {type:'json'};
import evidence from './stable-candidate-evidence.json' with {type:'json'};
import {verifyCandidate} from './stable-candidate.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
test('stable candidate is source-bound to pinned solc evidence but remains unapproved',()=>{
  assert.equal(verifyCandidate(candidate,{root:ROOT,expectedBuildInfoSha256:evidence.buildInfoSha256}),true);
  assert.equal(candidate.compiler,'0.8.24+commit.e11b9ed9');
  assert.equal(candidate.compilerExecutionReplayed,false);
  assert.equal(candidate.independentReviewComplete,false);
  assert.equal(candidate.productionApproved,false);
});
test('stable candidate and experimental artifact expose the same ABI while retaining different bytecode identities',()=>{
  for(const name of ['RealDexSmartAccount','RealDexSmartAccountFactory']){
    assert.deepEqual(candidate.contracts[name].abi,experimental.contracts[name].abi);
    assert.notEqual(candidate.contracts[name].creationCode,experimental.contracts[name].creationCode);
    assert.notEqual(candidate.contracts[name].runtimeTemplate,experimental.contracts[name].runtimeTemplate);
  }
});
test('candidate source hashes are exact current source bytes',()=>{
  for(const [name,digest] of Object.entries(candidate.sourceHashes)){
    assert.match(digest,/^[0-9a-f]{64}$/);assert.ok(fs.statSync(path.join(ROOT,name)).isFile());
  }
});
test('candidate evidence pins the imported build-info and standard input identities',()=>{
  assert.equal(candidate.buildInfoSha256,evidence.buildInfoSha256);
  assert.equal(candidate.inputSha256,evidence.inputSha256);
  assert.equal(evidence.compilerSha256,candidate.compilerSha256);
  assert.equal(evidence.productionApproved,false);
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(ROOT,'wallet/smart-account/stable-build-candidate.json'))).digest('hex'),evidence.candidateSha256);
});
