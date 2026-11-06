import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {keyInfo} from '../../wallet/lib/keys.mjs';
import {BUILD,LEGACY_ARTIFACT_ID,CURRENT_ARTIFACT_ID,artifactForDescriptor,descriptorArtifactId,normalizeDescriptor,predictAddress,validateSmartData,verifyBuildSources} from '../../wallet/smart-account/codec.mjs';
import {ARTIFACT_REGISTRY_SCHEMA,registeredArtifactIds,verifyArtifactRegistry} from '../../wallet/smart-account/artifacts.mjs';
import {vaultFixture,PASSWORD} from '../../wallet/test/fixtures.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const OWNER=keyInfo('evm',Buffer.from('55'.repeat(32),'hex')).address,FACTORY='0x'+'22'.repeat(20),SALT='0x'+'44'.repeat(32),GENESIS='0x'+'66'.repeat(32);
const legacy=(owner=OWNER,ownerAccountId='owner')=>({id:'legacy',label:'Legacy',ownerAccountId,chainId:'31337',genesisHash:GENESIS,factory:FACTORY,address:predictAddress(FACTORY,owner,SALT),salt:SALT});
const data=d=>({accounts:[{id:'owner',kind:'local',family:'evm',address:OWNER}],journal:[],smartAccounts:[d]});

test('legacy artifact snapshot is immutable and still equals the current product build',()=>{
  assert.equal(ARTIFACT_REGISTRY_SCHEMA,'realdex.smart-account-artifact-registry.v1');assert.equal(verifyArtifactRegistry(),true);assert.equal(verifyBuildSources(),true);assert.equal(CURRENT_ARTIFACT_ID,LEGACY_ARTIFACT_ID);
  assert.equal(sha(path.join(ROOT,'wallet/smart-account/build.json')),LEGACY_ARTIFACT_ID.slice(7));
  assert.equal(sha(path.join(ROOT,'wallet/smart-account/legacy-build-v1.json')),LEGACY_ARTIFACT_ID.slice(7));
  assert.deepEqual(registeredArtifactIds(),[LEGACY_ARTIFACT_ID]);assert.equal(artifactForDescriptor(legacy()),BUILD);assert.equal(Object.isFrozen(BUILD),true);assert.equal(Object.isFrozen(BUILD.contracts.RealDexSmartAccount),true);
});
test('old descriptors remain byte-shape compatible and resolve to the frozen legacy artifact',()=>{
  const d=legacy();assert.deepEqual(normalizeDescriptor(d),d);assert.equal(descriptorArtifactId(d),LEGACY_ARTIFACT_ID);assert.equal(validateSmartData(data(d)),undefined);
});
test('an explicit legacy artifact id is canonical and derives the same CREATE2 address',()=>{
  const d={...legacy(),artifactId:LEGACY_ARTIFACT_ID};assert.deepEqual(normalizeDescriptor(d),d);assert.equal(artifactForDescriptor(d),BUILD);assert.equal(validateSmartData(data(d)),undefined);
});
test('unknown or candidate-like artifact ids fail closed before descriptor acceptance',()=>{
  for(const artifactId of ['sha256:'+'0'.repeat(64),'stable-candidate']){const d={...legacy(),artifactId};assert.throws(()=>normalizeDescriptor(d),/SMART_ARTIFACT_UNSUPPORTED/);assert.throws(()=>validateSmartData(data(d)),/SMART_ARTIFACT_UNSUPPORTED/);}
});
test('artifact id cannot be smuggled through a noncanonical descriptor field',()=>{
  const d={...legacy(),artifactID:LEGACY_ARTIFACT_ID};assert.throws(()=>normalizeDescriptor(d),/SCHEMA_INVALID/);
});

test('explicit artifact binding survives encrypted vault persistence without rewriting it',async()=>{
  const f=await vaultFixture();try{const d={...legacy(f.account.address,f.account.id),artifactId:LEGACY_ARTIFACT_ID};await f.vault.addSmartAccount(d);await f.backup();f.vault.lock();await f.vault.unlock(PASSWORD);assert.deepEqual(f.vault.data.smartAccounts,[d]);assert.equal(descriptorArtifactId(f.vault.data.smartAccounts[0]),LEGACY_ARTIFACT_ID);}finally{f.close();}
});
