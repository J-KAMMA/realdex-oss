import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..'),load=n=>JSON.parse(fs.readFileSync(path.join(root,'plans',n)));
const plan=load('COMPLETION-INJ10-2026-09-07.json'),old=load('LOCAL-COMPLETION-2026-09-07.json');
test('INJ10 inherits the actual INJ09 parent and retains every prior completion task',()=>{
 assert.equal(plan.baseline.commit,'c03b78e73437100162b04ec85b0d0295cdbd5405');assert.equal(plan.baseline.sha256,'80f45670a132ba0d29e1cc965b0f89f3ecc2eda37ea2a130a5e16bdc7c9d31c8');
 assert.deepEqual(plan.tasks.map(x=>x.id),old.tasks.map(x=>x.id));assert.equal(plan.productionReady,false);assert.equal(plan.completionPercentage,null);assert.equal(plan.automaticPublication,false);
});
test('New recovery evidence exists, while blocked real-browser/release/backup boundaries remain explicit',()=>{
 assert.equal(plan.tasks.find(x=>x.id==='INJ-END-TO-END').status,'blocked');assert.equal(plan.tasks.find(x=>x.id==='LIMITED-RELEASE').status,'blocked');assert.equal(plan.tasks.find(x=>x.id==='INJ-RECOVERY').status,'in_progress');
 for(const t of plan.tasks)for(const p of t.evidencePaths)assert.ok(fs.existsSync(path.join(root,p)),p);
 assert.equal(plan.executionPolicy.noAdministrativePolicyBypass,true);assert.equal(plan.executionPolicy.verifyLocallyBeforeGitHub,true);
});
