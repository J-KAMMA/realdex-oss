import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {projectMetadata} from '../lib/project-metadata.mjs';import {doctor} from '../doctor.mjs';
const release={schema:'realdex.release-lineage.v1',version:'0.26.0-dev.20260906',productionReady:false};
function setup(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-project-metadata-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));
 fs.writeFileSync(path.join(p,'package.json'),JSON.stringify({version:'0.1.0',engines:{node:'24.14.0',pnpm:'11.25.0'},packageManager:'pnpm@11.25.0'}));
 fs.writeFileSync(path.join(p,'.node-version'),'24.14.0\n');fs.writeFileSync(path.join(p,'RELEASE.json'),JSON.stringify(release));return p;}
test('Doctor uses the delivered release rather than a stale hardcoded version',{skip:fs.existsSync(new URL('../../RELEASE.json',import.meta.url))?false:'requires RELEASE.json, which is not part of the public tree'},()=>{
 const root=path.resolve(new URL('../..',import.meta.url).pathname);const r=JSON.parse(fs.readFileSync(path.join(root,'RELEASE.json'),'utf8'));
 assert.equal(doctor().release,r.version);assert.equal(doctor().runtimeConfigurationConsistent,true);
});
test('Runtime identity distinguishes app release from original npm package version',t=>{const r=projectMetadata(setup(t));assert.equal(r.release,release.version);assert.equal(r.packageVersion,'0.1.0');assert.equal(r.configurationConsistent,true);});
for(const v of ['24.15.0','>=24','', '24.14.0\n25.0.0'])test('Conflicting or inexact .node-version blocks full build: '+JSON.stringify(v),t=>{
 const p=setup(t);fs.writeFileSync(path.join(p,'.node-version'),v);assert.equal(projectMetadata(p).configurationConsistent,false);
});
for(const v of ['pnpm@11.26.0','npm@11.25.0','pnpm@latest',null])test('Package manager version drift is explicit: '+v,t=>{
 const p=setup(t),f=path.join(p,'package.json'),j=JSON.parse(fs.readFileSync(f));j.packageManager=v;fs.writeFileSync(f,JSON.stringify(j));assert.ok(projectMetadata(p).problems.includes('PACKAGE_MANAGER_PIN_DISAGREEMENT'));
});
for(const v of [null,{}, {...release,productionReady:true},{...release,version:'latest'}])test('Invalid release metadata never substitutes another version '+JSON.stringify(v),t=>{
 const p=setup(t);fs.writeFileSync(path.join(p,'RELEASE.json'),JSON.stringify(v));const r=projectMetadata(p);assert.equal(r.release,null);assert.ok(r.problems.includes('RELEASE_METADATA_INVALID'));assert.equal(r.productionReady,false);
});
test('Inspecting project metadata never opens private .env or vault paths',t=>{
 const p=setup(t);fs.writeFileSync(path.join(p,'.env'),'IGNORED=not-a-real-secret');fs.mkdirSync(path.join(p,'.realdex-wallet'));fs.writeFileSync(path.join(p,'.realdex-wallet/vault.json'),'not-json');assert.equal(projectMetadata(p).configurationConsistent,true);
});
