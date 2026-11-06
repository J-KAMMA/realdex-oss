import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {inspectRoadmap} from '../roadmap.mjs';
const load=()=>JSON.parse(fs.readFileSync(new URL('../../plans/DEVELOPMENT-ROADMAP-2026-09-06.json',import.meta.url),'utf8'));
test('completion roadmap is acyclic, task-complete and does not grant release authority',()=>{const p=load(),x=inspectRoadmap(p);assert.equal(x.tasks.length,p.tasks.length);assert.equal(x.productionReady,false);assert.equal(x.authorizesExecution,false);assert.ok(x.tasks.some(t=>t.id==='TOP100-01'));});
test('roadmap rejects duplicate milestone identifiers',()=>{const p=load();p.tasks.push(p.tasks[0]);assert.throws(()=>inspectRoadmap(p),/ID/);});
test('roadmap rejects missing dependencies',()=>{const p=load();p.tasks[1].dependsOn=['GHOST'];assert.throws(()=>inspectRoadmap(p),/MISSING_DEPENDENCY/);});
test('roadmap rejects cycles rather than hiding impossible execution order',()=>{const p=load();p.tasks[0].dependsOn=[p.tasks.at(-1).id];assert.throws(()=>inspectRoadmap(p),/CYCLE/);});
test('readiness follows declared dependency states, not array order',()=>{const p=load();p.tasks[0].state='implemented_local';p.tasks.reverse();const x=inspectRoadmap(p);assert.ok(x.readyToWork.includes('BUILD-01'));assert.ok(!x.readyToWork.includes('LAUNCH-01'));});
test('declared plan state cannot assert production authorization',()=>{const p=load();p.productionReady=true;assert.throws(()=>inspectRoadmap(p),/SCHEMA/);});
test('every task needs explicit acceptance conditions',()=>{const p=load();p.tasks[1].acceptance=[];assert.throws(()=>inspectRoadmap(p),/ACCEPTANCE/);});


test('IBC acceptance requires tracking tests as well as packet transfer tests',()=>{
 const source=fs.readFileSync(new URL('../verify.mjs',import.meta.url),'utf8');assert.match(source,/run\('ibc-tracking-runtime'/);assert.match(source,/ibcAutomaticTrackingRuntimePassed/);assert.match(source,/requires-ibc-or-full-mode/);
});

test('external priorities remain the requested first five and all twelve providers are traceable',()=>{
 const p=load(),r=inspectRoadmap(p);assert.deepEqual(p.externalPriority,['injective','hyperliquid','chainflip','thorchain','jupiter']);assert.equal(p.externalCandidates.length,12);assert.equal(r.externalCandidates.length,12);assert.ok(p.externalCandidates.every(c=>p.tasks.some(t=>t.id===c.task)));});
test('read-only external work cannot grant production or signing authority',()=>{const p=load();p.externalCandidates[0].executionAuthorized=true;assert.throws(()=>inspectRoadmap(p),/AUTHORITY/);});
test('duplicate provider and absent implementation task cannot hide in an addendum',()=>{const p=load();p.externalCandidates[1].id=p.externalCandidates[0].id;assert.throws(()=>inspectRoadmap(p),/CANDIDATE/);const q=load();q.externalCandidates[1].task='MISSING';assert.throws(()=>inspectRoadmap(q),/CANDIDATE/);});
test('canonical baseline matches the imported v0.25 source archive',()=>{const p=load();assert.equal(p.baseline.archive,'RealDEX-External-Spot-v0.25-2026-09-06.zip');assert.equal(p.baseline.sha256,'86400113497752265f3de0d8bbd126c92a988052d196e78411fd3e46b143d621');assert.match(p.tasks.find(t=>t.id==='BASE-01').scope,/v0.25/);});
test('CCTP has one implementation task rather than a second parallel plan',()=>{const p=load();assert.equal(p.tasks.filter(t=>t.id==='BR-CCTP').length,1);assert.equal(p.externalCandidates.find(c=>c.id==='cctp').task,'BR-CCTP');});
test('implementation readiness and release blockers are separate',()=>{const p=load();p.tasks.find(t=>t.id==='EXT-INJ-READ').state='implemented_local';const r=inspectRoadmap(p),t=r.tasks.find(t=>t.id==='EXT-INJ');assert.equal(t.readyToWork,true);assert.ok(t.releaseWaitingFor.includes('BUILD-02'));assert.equal(t.authorizesExecution,false);});
test('release requirements must resolve to existing tasks',()=>{const p=load();p.tasks[0].releaseRequires=['GHOST'];assert.throws(()=>inspectRoadmap(p),/RELEASE_DEPENDENCY/);});
test('external observation tests are mandatory in normal verification',()=>{const s=fs.readFileSync(new URL('../verify.mjs',import.meta.url),'utf8');assert.match(s,/run\('external-spot-tests'/);assert.match(s,/localNames=.*'external-spot-tests'/);});

test('human roadmap is generated from the same canonical task source',async()=>{const {renderRoadmap}=await import('../render-roadmap.mjs');const doc=fs.readFileSync(new URL('../../plans/DEVELOPMENT-ROADMAP-JA-2026-09-06.md',import.meta.url),'utf8');assert.equal(doc.trim(),renderRoadmap(load()).trim());});

test('remote publication and unsigned orders remain explicitly incomplete',()=>{const p=load();assert.equal(p.tasks.find(t=>t.id==='DEV-GITHUB').state,'in_progress');assert.equal(p.tasks.find(t=>t.id==='EXT-INJ').state,'in_progress');assert.equal(p.workPolicy.gitIntegrationBranch,'main');});
