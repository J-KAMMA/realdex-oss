import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const hexBytes=v=>Buffer.from(String(v).replace(/^0x/,''),'hex');
const need=(ok,code)=>{if(!ok)throw Error(code);};

export function fileSha(file){return sha(fs.readFileSync(file));}
export const DESCRIPTOR_BINDING_FILES=Object.freeze(['wallet/smart-account/artifacts.mjs','wallet/smart-account/legacy-build-v1.json','wallet/smart-account/codec.mjs','wallet/smart-account/engine.mjs','wallet/smart-account/controller.mjs','wallet/smart-account/api.d.mts']);
export function descriptorBindingIdentity(root=ROOT){return Object.fromEntries(DESCRIPTOR_BINDING_FILES.map(name=>[name,fileSha(path.join(root,name))]));}
export function artifactIdentity(build){
  need(build&&typeof build==='object'&&build.contracts,'SMART_PROMOTION_BUILD_INVALID');
  const out={};
  for(const name of ['RealDexSmartAccount','RealDexSmartAccountFactory']){
    const c=build.contracts[name];
    need(c&&typeof c.creationCode==='string'&&typeof c.runtimeTemplate==='string','SMART_PROMOTION_CONTRACT_MISSING');
    out[name]={creationSha256:sha(hexBytes(c.creationCode)),runtimeSha256:sha(hexBytes(c.runtimeTemplate)),source:c.source,abiSha256:sha(Buffer.from(JSON.stringify(c.abi)))};
  }
  return out;
}
function sameAbi(a,b){return JSON.stringify(a)===JSON.stringify(b);}
export function assessStablePromotion({current,candidate,evidence,migrationPlan,migrationPlanSha256,currentSha256,candidateSha256}={}){
  need(current?.schema==='realdex.smart-account-build.v1','SMART_PROMOTION_CURRENT_SCHEMA');
  need(candidate?.schema==='realdex.smart-account-stable-candidate.v1','SMART_PROMOTION_CANDIDATE_SCHEMA');
  need(typeof currentSha256==='string'&&/^[0-9a-f]{64}$/.test(currentSha256),'SMART_PROMOTION_CURRENT_HASH');
  need(typeof candidateSha256==='string'&&/^[0-9a-f]{64}$/.test(candidateSha256),'SMART_PROMOTION_CANDIDATE_HASH');
  const currentId=artifactIdentity(current),candidateId=artifactIdentity(candidate);
  const computedMigrationPlanSha=migrationPlan&&typeof migrationPlan==='object'?sha(Buffer.from(JSON.stringify(migrationPlan,null,2)+'\n')):null;
  const sourceBound=Object.entries(candidate.sourceHashes??{}).every(([name,digest])=>current.sources?.[name]===digest);
  const abiStable=['RealDexSmartAccount','RealDexSmartAccountFactory'].every(name=>sameAbi(current.contracts[name].abi,candidate.contracts[name].abi));
  const deploymentIdentityChanged=['RealDexSmartAccount','RealDexSmartAccountFactory'].some(name=>currentId[name].creationSha256!==candidateId[name].creationSha256||currentId[name].runtimeSha256!==candidateId[name].runtimeSha256);
  const migrationPlanBound=migrationPlan?.schema==='realdex.smart-account-stable-migration-plan.v1'&&
    migrationPlan.currentArtifactSha256===currentSha256&&migrationPlan.candidateSha256===candidateSha256&&
    migrationPlan.newFactoryRequired===true&&migrationPlan.legacyAccountsRemainBound===true&&migrationPlan.legacyDescriptorRewriteAllowed===false&&
    migrationPlan.automaticMigrationAllowed===false&&migrationPlan.sameChainExistingFactoryReuseAllowed===false&&migrationPlan.productionApproved===false&&
    migrationPlan.descriptorBinding?.registrySchema==='realdex.smart-account-artifact-registry.v1'&&
    migrationPlan.descriptorBinding?.legacyArtifactId===`sha256:${currentSha256}`&&
    migrationPlan.descriptorBinding?.legacyDescriptorsWithoutArtifactIdResolveToLegacy===true&&
    migrationPlan.descriptorBinding?.nonLegacyArtifactIdRequired===true&&migrationPlan.descriptorBinding?.unknownArtifactIdsRejected===true&&
    migrationPlan.descriptorBinding?.legacyDescriptorCanonicalShapePreserved===true&&
    JSON.stringify(migrationPlan.descriptorBinding?.implementationSha256)===JSON.stringify(descriptorBindingIdentity())&&
    migrationPlan.legacyIdentity?.factoryRuntimeSha256===currentId.RealDexSmartAccountFactory.runtimeSha256&&
    migrationPlan.stableIdentity?.factoryRuntimeSha256===candidateId.RealDexSmartAccountFactory.runtimeSha256&&
    migrationPlan.legacyIdentity?.accountRuntimeSha256===currentId.RealDexSmartAccount.runtimeSha256&&
    migrationPlan.stableIdentity?.accountRuntimeSha256===candidateId.RealDexSmartAccount.runtimeSha256&&
    typeof migrationPlanSha256==='string'&&/^[0-9a-f]{64}$/.test(migrationPlanSha256)&&migrationPlanSha256===computedMigrationPlanSha;
  const reasons=[];
  if(!candidate.stableCompilerIdentity)reasons.push('STABLE_COMPILER_IDENTITY_UNVERIFIED');
  if(!sourceBound)reasons.push('STABLE_SOURCE_BINDING_MISMATCH');
  if(!abiStable)reasons.push('STABLE_ABI_CHANGED');
  if(!deploymentIdentityChanged)reasons.push('STABLE_DEPLOYMENT_IDENTITY_CHANGE_NOT_PROVEN');
  if(candidate.productionApproved===true)reasons.push('CANDIDATE_MUST_NOT_SELF_APPROVE');
  if(!migrationPlanBound)reasons.push('PROMOTION_MIGRATION_PLAN_INVALID');
  if(evidence?.schema!=='realdex.smart-account-stable-promotion-evidence.v1')reasons.push('PROMOTION_EVIDENCE_MISSING');
  else{
    if(evidence.currentArtifactSha256!==currentSha256)reasons.push('PROMOTION_CURRENT_ARTIFACT_HASH_MISMATCH');
    if(evidence.candidateSha256!==candidateSha256)reasons.push('PROMOTION_CANDIDATE_HASH_MISMATCH');
    if(evidence.compilerReplay?.passed!==true||evidence.compilerReplay?.compilerSha256!==candidate.compilerSha256)reasons.push('PROMOTION_COMPILER_REPLAY_REQUIRED');
    if(evidence.localEvm?.passed!==true||evidence.localEvm?.candidateSha256!==candidateSha256)reasons.push('PROMOTION_LOCAL_EVM_REQUIRED');
    if(evidence.independentReview?.passed!==true||!(/^[0-9a-f]{64}$/).test(evidence.independentReview?.reportSha256??''))reasons.push('PROMOTION_INDEPENDENT_REVIEW_REQUIRED');
    if(evidence.deploymentMigration?.approved!==true||evidence.deploymentMigration?.planSha256!==migrationPlanSha256||
      evidence.deploymentMigration?.newFactoryRequired!==true||evidence.deploymentMigration?.legacyAccountsRemainBound!==true||
      evidence.deploymentMigration?.legacyDescriptorRewriteAllowed!==false||evidence.deploymentMigration?.automaticMigrationAllowed!==false||
      evidence.deploymentMigration?.sameChainExistingFactoryReuseAllowed!==false||
      evidence.deploymentMigration?.descriptorRegistrySchema!=='realdex.smart-account-artifact-registry.v1'||
      evidence.deploymentMigration?.legacyArtifactId!==migrationPlan.descriptorBinding?.legacyArtifactId||
      evidence.deploymentMigration?.legacyDescriptorsWithoutArtifactIdResolveToLegacy!==true||
      evidence.deploymentMigration?.nonLegacyArtifactIdRequired!==true||evidence.deploymentMigration?.unknownArtifactIdsRejected!==true||
      evidence.deploymentMigration?.legacyDescriptorCanonicalShapePreserved!==true||
      evidence.deploymentMigration?.legacyFactoryRuntimeSha256!==currentId.RealDexSmartAccountFactory.runtimeSha256||
      evidence.deploymentMigration?.stableFactoryRuntimeSha256!==candidateId.RealDexSmartAccountFactory.runtimeSha256)reasons.push('PROMOTION_DEPLOYMENT_MIGRATION_REQUIRED');
  }
  return Object.freeze({schema:'realdex.smart-account-stable-promotion-readiness.v1',ready:reasons.length===0,productionApproved:false,automaticArtifactReplacementAllowed:false,
    currentArtifactSha256:currentSha256,candidateSha256,migrationPlanSha256,compiler:candidate.compiler,compilerSha256:candidate.compilerSha256,sourceBound,abiStable,deploymentIdentityChanged,migrationPlanBound,
    currentIdentity:currentId,candidateIdentity:candidateId,reasons});
}
export function assessFiles({current=path.join(ROOT,'wallet/smart-account/build.json'),candidate=path.join(ROOT,'wallet/smart-account/stable-build-candidate.json'),migrationPlan=path.join(ROOT,'integration/smart-account/stable-migration-plan.json'),evidence}={}){
  const currentBytes=fs.readFileSync(current),candidateBytes=fs.readFileSync(candidate),migrationBytes=fs.readFileSync(migrationPlan);
  const evidenceObject=evidence?JSON.parse(fs.readFileSync(evidence,'utf8')):undefined;
  return assessStablePromotion({current:JSON.parse(currentBytes),candidate:JSON.parse(candidateBytes),migrationPlan:JSON.parse(migrationBytes),migrationPlanSha256:sha(migrationBytes),evidence:evidenceObject,currentSha256:sha(currentBytes),candidateSha256:sha(candidateBytes)});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);let output,evidence;
  for(let i=0;i<args.length;i++){if(args[i]==='--output')output=args[++i];else if(args[i]==='--evidence')evidence=args[++i];else throw Error('SMART_PROMOTION_ARGUMENTS');}
  if(!output)throw Error('SMART_PROMOTION_OUTPUT_REQUIRED');const resolved=path.resolve(output);if(fs.existsSync(resolved))throw Error('SMART_PROMOTION_OUTPUT_EXISTS');
  const result=assessFiles({evidence:evidence?path.resolve(evidence):undefined});fs.writeFileSync(resolved,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
}
