import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import current from '../../wallet/smart-account/build.json' with {type:'json'};
import candidate from '../../wallet/smart-account/stable-build-candidate.json' with {type:'json'};
import plan from '../../integration/smart-account/stable-migration-plan.json' with {type:'json'};
import {createStableMigrationPlan,predictWithArtifact,verifyStableMigrationPlan,migrationPlanSha} from '../../integration/smart-account/stable-migration-plan.mjs';
import {fileSha} from '../../integration/smart-account/stable-promotion.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const currentFile=path.join(ROOT,'wallet/smart-account/build.json');
const candidateFile=path.join(ROOT,'wallet/smart-account/stable-build-candidate.json');
const planFile=path.join(ROOT,'integration/smart-account/stable-migration-plan.json');
const args=()=>({current,candidate,currentArtifactSha256:fileSha(currentFile),candidateSha256:fileSha(candidateFile)});

test('committed migration plan is exactly reproducible from both artifacts',()=>{
  const generated=createStableMigrationPlan(args());
  assert.deepEqual(generated,plan);
  assert.equal(verifyStableMigrationPlan(plan,args()),true);
  assert.equal(migrationPlanSha(plan),fileSha(planFile));
});
test('stable artifact needs a new factory and leaves legacy descriptors untouched',()=>{
  assert.equal(plan.strategy,'dual-factory-versioned');
  assert.equal(plan.newFactoryRequired,true);
  assert.equal(plan.legacyAccountsRemainBound,true);
  assert.equal(plan.legacyDescriptorRewriteAllowed,false);
  assert.equal(plan.automaticMigrationAllowed,false);
  assert.equal(plan.sameChainExistingFactoryReuseAllowed,false);
  assert.equal(plan.productionApproved,false);
  assert.equal(plan.independentReviewComplete,false);
  assert.equal(plan.descriptorBinding.registrySchema,'realdex.smart-account-artifact-registry.v1');assert.equal(plan.descriptorBinding.legacyArtifactId,`sha256:${args().currentArtifactSha256}`);
  for(const field of ['legacyDescriptorsWithoutArtifactIdResolveToLegacy','nonLegacyArtifactIdRequired','unknownArtifactIdsRejected','legacyDescriptorCanonicalShapePreserved'])assert.equal(plan.descriptorBinding[field],true);
  assert.deepEqual(Object.keys(plan.descriptorBinding.implementationSha256).sort(),['wallet/smart-account/api.d.mts','wallet/smart-account/artifacts.mjs','wallet/smart-account/codec.mjs','wallet/smart-account/controller.mjs','wallet/smart-account/engine.mjs','wallet/smart-account/legacy-build-v1.json']);
});
test('same factory owner and salt resolve to different account identities after compiler change',()=>{
  const p=plan.sameFactoryProbe;
  assert.equal(p.legacyAccount,predictWithArtifact(current,p.factory,p.owner,p.salt));
  assert.equal(p.stableAccount,predictWithArtifact(candidate,p.factory,p.owner,p.salt));
  assert.notEqual(p.legacyAccount,p.stableAccount);
  assert.equal(p.addressesDiffer,true);
});
test('factory and account runtime identities both change across the stable build',()=>{
  assert.notEqual(plan.legacyIdentity.factoryRuntimeSha256,plan.stableIdentity.factoryRuntimeSha256);
  assert.notEqual(plan.legacyIdentity.accountRuntimeSha256,plan.stableIdentity.accountRuntimeSha256);
  assert.notEqual(plan.legacyIdentity.factoryCreationSha256,plan.stableIdentity.factoryCreationSha256);
  assert.notEqual(plan.legacyIdentity.accountCreationSha256,plan.stableIdentity.accountCreationSha256);
});
test('migration requirements prohibit in-place or silent legacy descriptor conversion',()=>{
  assert.ok(plan.requirements.includes('deploy-stable-factory-at-new-address'));
  assert.ok(plan.requirements.includes('keep-legacy-factory-and-accounts-bound-to-current-artifact'));
  assert.ok(plan.requirements.includes('do-not-rewrite-legacy-smart-account-descriptors'));
  assert.ok(plan.requirements.includes('bind-each-non-legacy-descriptor-to-explicit-artifact-id'));
  assert.ok(plan.requirements.includes('require-independent-review-before-production-promotion'));
});
test('tampering with any safety policy makes the plan unverifiable',()=>{
  for(const [field,value] of [
    ['newFactoryRequired',false],['legacyAccountsRemainBound',false],['legacyDescriptorRewriteAllowed',true],
    ['automaticMigrationAllowed',true],['sameChainExistingFactoryReuseAllowed',true],['productionApproved',true],
  ]){
    const changed=structuredClone(plan);changed[field]=value;
    assert.throws(()=>verifyStableMigrationPlan(changed,args()),/SMART_MIGRATION_PLAN_MISMATCH/);
  }
});
test('migration plan is byte-bound to the current and stable candidate artifacts',()=>{
  for(const field of ['currentArtifactSha256','candidateSha256']){
    const changed=structuredClone(plan);changed[field]='0'.repeat(64);
    assert.throws(()=>verifyStableMigrationPlan(changed,args()),/SMART_MIGRATION_PLAN_MISMATCH/);
  }
});
test('descriptor binding cannot be removed or redirected to another artifact',()=>{
  for(const [field,value] of [['legacyArtifactId','sha256:'+'0'.repeat(64)],['legacyDescriptorsWithoutArtifactIdResolveToLegacy',false],['nonLegacyArtifactIdRequired',false],['unknownArtifactIdsRejected',false],['legacyDescriptorCanonicalShapePreserved',false]]){
    const changed=structuredClone(plan);changed.descriptorBinding[field]=value;assert.throws(()=>verifyStableMigrationPlan(changed,args()),/SMART_MIGRATION_PLAN_MISMATCH/);
  }
});
test('descriptor binding is byte-bound to the runtime implementation',()=>{const changed=structuredClone(plan);changed.descriptorBinding.implementationSha256['wallet/smart-account/codec.mjs']='0'.repeat(64);assert.throws(()=>verifyStableMigrationPlan(changed,args()),/SMART_MIGRATION_PLAN_MISMATCH/);});
test('migration plan is byte-bound to both factory runtime identities',()=>{
  for(const side of ['legacyIdentity','stableIdentity']){
    const changed=structuredClone(plan);changed[side].factoryRuntimeSha256='0'.repeat(64);
    assert.throws(()=>verifyStableMigrationPlan(changed,args()),/SMART_MIGRATION_PLAN_MISMATCH/);
  }
});
test('invalid CREATE2 inputs fail closed',()=>{
  assert.throws(()=>predictWithArtifact(current,'not-an-address',plan.sameFactoryProbe.owner,plan.sameFactoryProbe.salt));
  assert.throws(()=>predictWithArtifact(current,plan.sameFactoryProbe.factory,plan.sameFactoryProbe.owner,'0x12'));
});
