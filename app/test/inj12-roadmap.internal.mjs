import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..'),read=n=>JSON.parse(fs.readFileSync(path.join(root,'plans/'+n+'.json'),'utf8'));
const old=read('COMPLETION-INJ11-2026-09-07'),plan=read('COMPLETION-INJ12-2026-09-07');
test('INJ12 keeps task IDs/dependencies/acceptance and distinguishes a gas-estimate fix from full reliability',()=>{
 assert.deepEqual(plan.tasks.map(t=>t.id),old.tasks.map(t=>t.id));
 for(const t of old.tasks){const next=plan.tasks.find(x=>x.id===t.id);assert.deepEqual(next.dependsOn,t.dependsOn);for(const criterion of t.acceptance)assert.ok(next.acceptance.includes(criterion));}
 assert.equal(plan.tasks.find(t=>t.id==='IBC-STABILITY').status,'in_progress');assert.equal(plan.productionReady,false);assert.equal(plan.completionPercentage,null);assert.equal(plan.baseline.commit,'99af36d2dc57a5f1cf7f2af8a55adaf0f737c573');
});
test('INJ12 roadmap evidence exists and no independent release/browser approval is invented',()=>{
 for(const t of plan.tasks)for(const p of t.evidencePaths)assert.ok(fs.existsSync(path.join(root,p)),p);
 assert.equal(plan.tasks.find(t=>t.id==='INJ-END-TO-END').status,'blocked');assert.equal(plan.tasks.find(t=>t.id==='LIMITED-RELEASE').status,'blocked');assert.equal(plan.executionPolicy.noAdministrativePolicyBypass,true);assert.equal(plan.executionPolicy.noFeeLimitOrStateAgreementRelaxation,true);
});
