/** Immutable smart-account artifact registry. Legacy descriptors without artifactId stay bound here forever. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {need,text} from '../lib/guard.mjs';
import legacyArtifactJson from './legacy-build-v1.json' with {type:'json'};

const DIR=path.dirname(fileURLToPath(import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const deepFreeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))deepFreeze(x);Object.freeze(v);}return v;};
const legacyArtifact=deepFreeze(legacyArtifactJson);
export const ARTIFACT_REGISTRY_SCHEMA='realdex.smart-account-artifact-registry.v1';
export const LEGACY_ARTIFACT_SHA256='0c49254b131bc0925952ee58df4388441608046c80665c0c73e642314c793980';
export const LEGACY_ARTIFACT_ID=`sha256:${LEGACY_ARTIFACT_SHA256}`;
export const CURRENT_ARTIFACT_ID=LEGACY_ARTIFACT_ID;
const RECORDS=new Map([[LEGACY_ARTIFACT_ID,Object.freeze({
  id:LEGACY_ARTIFACT_ID,
  artifact:legacyArtifact,
  snapshot:path.join(DIR,'legacy-build-v1.json'),
  sha256:LEGACY_ARTIFACT_SHA256,
  legacyDefault:true,
})]]);
export const CURRENT_ARTIFACT=legacyArtifact;
export function descriptorArtifactId(value){
  if(!Object.hasOwn(value,'artifactId'))return LEGACY_ARTIFACT_ID;
  text(value.artifactId,96);need(RECORDS.has(value.artifactId),'SMART_ARTIFACT_UNSUPPORTED');return value.artifactId;
}
export function artifactRecord(id){text(id,96);const r=RECORDS.get(id);need(r,'SMART_ARTIFACT_UNSUPPORTED');return r;}
export const artifactById=id=>artifactRecord(id).artifact;
export function artifactIdForBuild(build){for(const r of RECORDS.values())if(r.artifact===build)return r.id;throw Error('SMART_ARTIFACT_UNSUPPORTED');}
export const artifactForDescriptor=value=>artifactById(descriptorArtifactId(value));
export function verifyArtifactRegistry(){
  for(const r of RECORDS.values())need(sha(fs.readFileSync(r.snapshot))===r.sha256,'SMART_ARTIFACT_SNAPSHOT_MISMATCH');
  return true;
}
export function registeredArtifactIds(){return [...RECORDS.keys()];}
