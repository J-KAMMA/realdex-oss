import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assessStablePromotion,assessFiles,fileSha} from '../../integration/smart-account/stable-promotion.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const currentFile=path.join(ROOT,'wallet/smart-account/build.json');
const candidateFile=path.join(ROOT,'wallet/smart-account/stable-build-candidate.json');
const current=JSON.parse(fs.readFileSync(currentFile));
const candidate=JSON.parse(fs.readFileSync(candidateFile));
const migrationFile=path.join(ROOT,'integration/smart-account/stable-migration-plan.json');
const migrationPlan=JSON.parse(fs.readFileSync(migrationFile));
const currentSha256=fileSha(currentFile),candidateSha256=fileSha(candidateFile),migrationPlanSha256=fileSha(migrationFile);
const baseArgs=()=>({current,candidate,migrationPlan,migrationPlanSha256,currentSha256,candidateSha256});
const evidence=()=>({schema:'realdex.smart-account-stable-promotion-evidence.v1',currentArtifactSha256:currentSha256,candidateSha256,
 compilerReplay:{passed:true,compilerSha256:candidate.compilerSha256},localEvm:{passed:true,candidateSha256},independentReview:{passed:true,reportSha256:'1'.repeat(64)},
 deploymentMigration:{approved:true,planSha256:migrationPlanSha256,newFactoryRequired:true,legacyAccountsRemainBound:true,legacyDescriptorRewriteAllowed:false,automaticMigrationAllowed:false,sameChainExistingFactoryReuseAllowed:false,
   descriptorRegistrySchema:migrationPlan.descriptorBinding.registrySchema,legacyArtifactId:migrationPlan.descriptorBinding.legacyArtifactId,
   legacyDescriptorsWithoutArtifactIdResolveToLegacy:true,nonLegacyArtifactIdRequired:true,unknownArtifactIdsRejected:true,legacyDescriptorCanonicalShapePreserved:true,
   legacyFactoryRuntimeSha256:migrationPlan.legacyIdentity.factoryRuntimeSha256,stableFactoryRuntimeSha256:migrationPlan.stableIdentity.factoryRuntimeSha256}});

test('real stable candidate is source/ABI compatible but changes deployment identity',()=>{const r=assessFiles();assert.equal(r.ready,false);assert.equal(r.sourceBound,true);assert.equal(r.abiStable,true);assert.equal(r.deploymentIdentityChanged,true);assert.equal(r.automaticArtifactReplacementAllowed,false);assert.deepEqual(r.reasons,['PROMOTION_EVIDENCE_MISSING']);});
test('complete external evidence can make the promotion plan reviewable but never auto-approved',()=>{const r=assessStablePromotion({...baseArgs(),evidence:evidence()});assert.equal(r.ready,true);assert.equal(r.productionApproved,false);assert.equal(r.automaticArtifactReplacementAllowed,false);assert.deepEqual(r.reasons,[]);});
test('compiler replay is bound to exact pinned compiler identity',()=>{const e=evidence();e.compilerReplay.compilerSha256='2'.repeat(64);const r=assessStablePromotion({...baseArgs(),evidence:e});assert.deepEqual(r.reasons,['PROMOTION_COMPILER_REPLAY_REQUIRED']);});
test('local EVM evidence is bound to the exact candidate bytes',()=>{const e=evidence();e.localEvm.candidateSha256='3'.repeat(64);const r=assessStablePromotion({...baseArgs(),evidence:e});assert.deepEqual(r.reasons,['PROMOTION_LOCAL_EVM_REQUIRED']);});
test('independent review requires an external report digest',()=>{const e=evidence();e.independentReview={passed:true,reportSha256:'no'};const r=assessStablePromotion({...baseArgs(),evidence:e});assert.deepEqual(r.reasons,['PROMOTION_INDEPENDENT_REVIEW_REQUIRED']);});
test('migration plan must explicitly preserve legacy deployment identity',()=>{const e=evidence();e.deploymentMigration.legacyAccountsRemainBound=false;const r=assessStablePromotion({...baseArgs(),evidence:e});assert.deepEqual(r.reasons,['PROMOTION_DEPLOYMENT_MIGRATION_REQUIRED']);});
test('evidence cannot be reused for another current or candidate artifact',()=>{for(const field of ['currentArtifactSha256','candidateSha256']){const e=evidence();e[field]='4'.repeat(64);const r=assessStablePromotion({...baseArgs(),evidence:e});assert.ok(r.reasons.includes(field==='currentArtifactSha256'?'PROMOTION_CURRENT_ARTIFACT_HASH_MISMATCH':'PROMOTION_CANDIDATE_HASH_MISMATCH'));}});
test('candidate can never self-assert production approval',()=>{const c=structuredClone(candidate);c.productionApproved=true;const r=assessStablePromotion({...baseArgs(),candidate:c,evidence:evidence()});assert.ok(r.reasons.includes('CANDIDATE_MUST_NOT_SELF_APPROVE'));});
test('ABI changes fail closed before promotion',()=>{const c=structuredClone(candidate);c.contracts.RealDexSmartAccount.abi=[];const r=assessStablePromotion({...baseArgs(),candidate:c,evidence:evidence()});assert.ok(r.reasons.includes('STABLE_ABI_CHANGED'));});
test('source binding changes fail closed before promotion',()=>{const c=structuredClone(candidate);c.sourceHashes['contracts/smart/RealDexSmartAccount.sol']='0'.repeat(64);const r=assessStablePromotion({...baseArgs(),candidate:c,evidence:evidence()});assert.ok(r.reasons.includes('STABLE_SOURCE_BINDING_MISMATCH'));});

test('migration evidence is bound to the exact reviewed plan digest',()=>{const e=evidence();e.deploymentMigration.planSha256='5'.repeat(64);const r=assessStablePromotion({...baseArgs(),evidence:e});assert.deepEqual(r.reasons,['PROMOTION_DEPLOYMENT_MIGRATION_REQUIRED']);});
test('migration evidence must bind the descriptor artifact registry',()=>{for(const [field,value] of [['legacyArtifactId','sha256:'+'0'.repeat(64)],['legacyDescriptorsWithoutArtifactIdResolveToLegacy',false],['nonLegacyArtifactIdRequired',false],['unknownArtifactIdsRejected',false],['legacyDescriptorCanonicalShapePreserved',false]]){const e=evidence();e.deploymentMigration[field]=value;const r=assessStablePromotion({...baseArgs(),evidence:e});assert.deepEqual(r.reasons,['PROMOTION_DEPLOYMENT_MIGRATION_REQUIRED']);}});
test('migration evidence cannot substitute either factory runtime identity',()=>{for(const field of ['legacyFactoryRuntimeSha256','stableFactoryRuntimeSha256']){const e=evidence();e.deploymentMigration[field]='6'.repeat(64);const r=assessStablePromotion({...baseArgs(),evidence:e});assert.deepEqual(r.reasons,['PROMOTION_DEPLOYMENT_MIGRATION_REQUIRED']);}});
test('migration plan tampering blocks promotion before external evidence is considered',()=>{const p=structuredClone(migrationPlan);p.legacyDescriptorRewriteAllowed=true;const r=assessStablePromotion({...baseArgs(),migrationPlan:p,evidence:evidence()});assert.ok(r.reasons.includes('PROMOTION_MIGRATION_PLAN_INVALID'));});
test('automatic or same-factory migration policy is fail closed',()=>{for(const field of ['automaticMigrationAllowed','sameChainExistingFactoryReuseAllowed']){const e=evidence();e.deploymentMigration[field]=true;const r=assessStablePromotion({...baseArgs(),evidence:e});assert.deepEqual(r.reasons,['PROMOTION_DEPLOYMENT_MIGRATION_REQUIRED']);}});
