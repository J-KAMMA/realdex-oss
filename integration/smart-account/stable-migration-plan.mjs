import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {address,keccak256} from '../../node/verified/keccak.mjs';
import {abiAddress} from '../../wallet/lib/transactions.mjs';
import {hex,need} from '../../wallet/lib/guard.mjs';
import {artifactIdentity,descriptorBindingIdentity,fileSha} from './stable-promotion.mjs';
import {LEGACY_ARTIFACT_ID} from '../../wallet/smart-account/artifacts.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const PROBE=Object.freeze({
  factory:'0x2222222222222222222222222222222222222222',
  owner:'0x1111111111111111111111111111111111111111',
  salt:'0x'+'33'.repeat(32),
});

function checkArtifact(artifact,schema,code){
  need(artifact?.schema===schema,code);
  need(artifact.contracts?.RealDexSmartAccount&&artifact.contracts?.RealDexSmartAccountFactory,code);
  return artifact;
}
export function predictWithArtifact(artifact,factory,owner,salt){
  factory=address(factory);owner=address(owner);hex(salt,32);salt=salt.toLowerCase();
  const derived=keccak256('0x'+abiAddress(owner)+salt.slice(2));
  const creation=artifact.contracts.RealDexSmartAccount.creationCode;
  const initHash=keccak256(creation+abiAddress(owner));
  return address('0x'+keccak256('0xff'+factory.slice(2)+derived.slice(2)+initHash.slice(2)).slice(-40));
}
export function createStableMigrationPlan({current,candidate,currentArtifactSha256,candidateSha256}={}){
  checkArtifact(current,'realdex.smart-account-build.v1','SMART_MIGRATION_CURRENT_SCHEMA');
  checkArtifact(candidate,'realdex.smart-account-stable-candidate.v1','SMART_MIGRATION_CANDIDATE_SCHEMA');
  need(/^[0-9a-f]{64}$/.test(currentArtifactSha256??''),'SMART_MIGRATION_CURRENT_HASH');
  need(/^[0-9a-f]{64}$/.test(candidateSha256??''),'SMART_MIGRATION_CANDIDATE_HASH');
  need(LEGACY_ARTIFACT_ID===`sha256:${currentArtifactSha256}`,'SMART_MIGRATION_LEGACY_ARTIFACT_ID');
  const oldId=artifactIdentity(current),nextId=artifactIdentity(candidate);
  const oldAddress=predictWithArtifact(current,PROBE.factory,PROBE.owner,PROBE.salt);
  const nextAddress=predictWithArtifact(candidate,PROBE.factory,PROBE.owner,PROBE.salt);
  need(oldAddress!==nextAddress,'SMART_MIGRATION_ACCOUNT_IDENTITY_UNCHANGED');
  need(oldId.RealDexSmartAccountFactory.runtimeSha256!==nextId.RealDexSmartAccountFactory.runtimeSha256,'SMART_MIGRATION_FACTORY_IDENTITY_UNCHANGED');
  return Object.freeze({
    schema:'realdex.smart-account-stable-migration-plan.v1',
    strategy:'dual-factory-versioned',
    currentArtifactSha256,candidateSha256,
    newFactoryRequired:true,
    legacyAccountsRemainBound:true,
    legacyDescriptorRewriteAllowed:false,
    automaticMigrationAllowed:false,
    sameChainExistingFactoryReuseAllowed:false,
    productionApproved:false,
    independentReviewComplete:false,
    descriptorBinding:{
      registrySchema:'realdex.smart-account-artifact-registry.v1',
      legacyArtifactId:LEGACY_ARTIFACT_ID,
      legacyDescriptorsWithoutArtifactIdResolveToLegacy:true,
      nonLegacyArtifactIdRequired:true,
      unknownArtifactIdsRejected:true,
      legacyDescriptorCanonicalShapePreserved:true,
      implementationSha256:descriptorBindingIdentity(),
    },
    legacyIdentity:{
      accountCreationSha256:oldId.RealDexSmartAccount.creationSha256,
      accountRuntimeSha256:oldId.RealDexSmartAccount.runtimeSha256,
      factoryCreationSha256:oldId.RealDexSmartAccountFactory.creationSha256,
      factoryRuntimeSha256:oldId.RealDexSmartAccountFactory.runtimeSha256,
    },
    stableIdentity:{
      accountCreationSha256:nextId.RealDexSmartAccount.creationSha256,
      accountRuntimeSha256:nextId.RealDexSmartAccount.runtimeSha256,
      factoryCreationSha256:nextId.RealDexSmartAccountFactory.creationSha256,
      factoryRuntimeSha256:nextId.RealDexSmartAccountFactory.runtimeSha256,
    },
    sameFactoryProbe:{...PROBE,legacyAccount:oldAddress,stableAccount:nextAddress,addressesDiffer:true},
    requirements:[
      'deploy-stable-factory-at-new-address',
      'keep-legacy-factory-and-accounts-bound-to-current-artifact',
      'verify-stable-factory-runtime-before-new-account-registration',
      'do-not-rewrite-legacy-smart-account-descriptors',
      'bind-each-non-legacy-descriptor-to-explicit-artifact-id',
      'require-independent-review-before-production-promotion',
    ],
  });
}
export function verifyStableMigrationPlan(plan,{current,candidate,currentArtifactSha256,candidateSha256}={}){
  need(plan?.schema==='realdex.smart-account-stable-migration-plan.v1','SMART_MIGRATION_PLAN_SCHEMA');
  const expected=createStableMigrationPlan({current,candidate,currentArtifactSha256,candidateSha256});
  need(JSON.stringify(plan)===JSON.stringify(expected),'SMART_MIGRATION_PLAN_MISMATCH');
  return true;
}
export function planFiles({current=path.join(ROOT,'wallet/smart-account/build.json'),candidate=path.join(ROOT,'wallet/smart-account/stable-build-candidate.json')}={}){
  const currentBytes=fs.readFileSync(current),candidateBytes=fs.readFileSync(candidate);
  return createStableMigrationPlan({current:JSON.parse(currentBytes),candidate:JSON.parse(candidateBytes),currentArtifactSha256:sha(currentBytes),candidateSha256:sha(candidateBytes)});
}
export function migrationPlanSha(plan){return sha(Buffer.from(JSON.stringify(plan,null,2)+'\n'));}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);let output;
  for(let i=0;i<args.length;i++){if(args[i]==='--output')output=args[++i];else throw Error('SMART_MIGRATION_ARGUMENTS');}
  need(output,'SMART_MIGRATION_OUTPUT_REQUIRED');const resolved=path.resolve(output);need(!fs.existsSync(resolved),'SMART_MIGRATION_OUTPUT_EXISTS');
  const plan=planFiles();fs.writeFileSync(resolved,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({schema:'realdex.smart-account-stable-migration-plan-write.v1',output:resolved,sha256:fileSha(resolved),productionApproved:false}));
}
