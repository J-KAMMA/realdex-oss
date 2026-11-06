#!/usr/bin/env python3
"""Independent structural/hash checker for the stable smart-account migration plan."""
from __future__ import annotations
import hashlib, json, pathlib, sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
CUR=ROOT/'wallet/smart-account/build.json'
CAN=ROOT/'wallet/smart-account/stable-build-candidate.json'
PLAN=ROOT/'integration/smart-account/stable-migration-plan.json'
checks=0

def ck(ok,code):
    global checks
    checks+=1
    if not ok: raise RuntimeError(code)
def hfile(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def hhex(v): return hashlib.sha256(bytes.fromhex(v.removeprefix('0x'))).hexdigest()

def main():
    c=json.loads(CUR.read_text()); n=json.loads(CAN.read_text()); p=json.loads(PLAN.read_text())
    ck(p.get('schema')=='realdex.smart-account-stable-migration-plan.v1','MIG_PY_SCHEMA')
    ck(p.get('strategy')=='dual-factory-versioned','MIG_PY_STRATEGY')
    ck(p.get('currentArtifactSha256')==hfile(CUR),'MIG_PY_CURRENT_HASH')
    ck(p.get('candidateSha256')==hfile(CAN),'MIG_PY_CANDIDATE_HASH')
    for field,want in [('newFactoryRequired',True),('legacyAccountsRemainBound',True),('legacyDescriptorRewriteAllowed',False),('automaticMigrationAllowed',False),('sameChainExistingFactoryReuseAllowed',False),('productionApproved',False),('independentReviewComplete',False)]:
        ck(p.get(field) is want,'MIG_PY_POLICY_'+field.upper())
    db=p.get('descriptorBinding') or {}
    ck(db.get('registrySchema')=='realdex.smart-account-artifact-registry.v1','MIG_PY_REGISTRY_SCHEMA')
    ck(db.get('legacyArtifactId')=='sha256:'+hfile(CUR),'MIG_PY_LEGACY_ARTIFACT_ID')
    for field in ['legacyDescriptorsWithoutArtifactIdResolveToLegacy','nonLegacyArtifactIdRequired','unknownArtifactIdsRejected','legacyDescriptorCanonicalShapePreserved']:
        ck(db.get(field) is True,'MIG_PY_DESCRIPTOR_'+field.upper())
    implementation=db.get('implementationSha256') or {}
    binding_files=['wallet/smart-account/artifacts.mjs','wallet/smart-account/legacy-build-v1.json','wallet/smart-account/codec.mjs','wallet/smart-account/engine.mjs','wallet/smart-account/controller.mjs','wallet/smart-account/api.d.mts']
    ck(set(implementation)==set(binding_files),'MIG_PY_DESCRIPTOR_FILES')
    for name in binding_files: ck(implementation.get(name)==hfile(ROOT/name),'MIG_PY_DESCRIPTOR_HASH_'+name.upper().replace('/','_').replace('.','_'))
    for side,artifact in [('legacyIdentity',c),('stableIdentity',n)]:
        ident=p.get(side) or {}; contracts=artifact['contracts']
        ck(ident.get('accountCreationSha256')==hhex(contracts['RealDexSmartAccount']['creationCode']),'MIG_PY_ACCOUNT_CREATION_'+side)
        ck(ident.get('accountRuntimeSha256')==hhex(contracts['RealDexSmartAccount']['runtimeTemplate']),'MIG_PY_ACCOUNT_RUNTIME_'+side)
        ck(ident.get('factoryCreationSha256')==hhex(contracts['RealDexSmartAccountFactory']['creationCode']),'MIG_PY_FACTORY_CREATION_'+side)
        ck(ident.get('factoryRuntimeSha256')==hhex(contracts['RealDexSmartAccountFactory']['runtimeTemplate']),'MIG_PY_FACTORY_RUNTIME_'+side)
    probe=p.get('sameFactoryProbe') or {}
    for field in ['factory','owner','legacyAccount','stableAccount']:
        v=probe.get(field,'');ck(isinstance(v,str) and v.startswith('0x') and len(v)==42,'MIG_PY_PROBE_'+field.upper())
    ck(isinstance(probe.get('salt'),str) and probe['salt'].startswith('0x') and len(probe['salt'])==66,'MIG_PY_PROBE_SALT')
    ck(probe.get('legacyAccount')!=probe.get('stableAccount'),'MIG_PY_PROBE_DISTINCT')
    ck(probe.get('addressesDiffer') is True,'MIG_PY_PROBE_FLAG')
    req=p.get('requirements');ck(isinstance(req,list) and len(req)==6 and len(set(req))==6,'MIG_PY_REQUIREMENTS')
    for item in ['deploy-stable-factory-at-new-address','keep-legacy-factory-and-accounts-bound-to-current-artifact','verify-stable-factory-runtime-before-new-account-registration','do-not-rewrite-legacy-smart-account-descriptors','bind-each-non-legacy-descriptor-to-explicit-artifact-id','require-independent-review-before-production-promotion']:
        ck(item in req,'MIG_PY_REQ_'+item.upper().replace('-','_'))
    ck(c['contracts']['RealDexSmartAccount']['abi']==n['contracts']['RealDexSmartAccount']['abi'],'MIG_PY_ACCOUNT_ABI')
    ck(c['contracts']['RealDexSmartAccountFactory']['abi']==n['contracts']['RealDexSmartAccountFactory']['abi'],'MIG_PY_FACTORY_ABI')
    ck(p['legacyIdentity']['accountRuntimeSha256']!=p['stableIdentity']['accountRuntimeSha256'],'MIG_PY_ACCOUNT_RUNTIME_DISTINCT')
    ck(p['legacyIdentity']['factoryRuntimeSha256']!=p['stableIdentity']['factoryRuntimeSha256'],'MIG_PY_FACTORY_RUNTIME_DISTINCT')
    print(json.dumps({'schema':'realdex.smart-account-stable-migration-python-check.v1','success':True,'checks':checks,'planSha256':hfile(PLAN),'productionApproved':False},separators=(',',':')))
    return 0
if __name__=='__main__':
    try: raise SystemExit(main())
    except Exception as e:
        print(str(e),file=sys.stderr);raise SystemExit(1)
