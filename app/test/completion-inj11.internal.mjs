import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const root=new URL('../../',import.meta.url),load=p=>JSON.parse(fs.readFileSync(new URL('plans/'+p,root)));
const current=load('COMPLETION-INJ11-2026-09-07.json'),parent=load('COMPLETION-INJ10-2026-09-07.json');
test('INJ11 preserves all tasks, dependencies, release blockers and exact INJ10 parent',()=>{
 assert.equal(current.baseline.commit,'449341b3b2ea296b4285af17a89962aef8565fe4');assert.equal(current.baseline.sha256,'dbf4d962079898f8783baf444b79674d6a01bd4800c98d90ebec9524a917fc70');
 assert.deepEqual(current.tasks.map(t=>[t.id,t.dependsOn,t.acceptance]),parent.tasks.map(t=>[t.id,t.dependsOn,t.acceptance]));
 assert.equal(current.productionReady,false);assert.equal(current.completionPercentage,null);assert.equal(current.automaticPublication,false);
});
test('INJ11 test integration does not claim browser unblock or historic RPC root cause completion',()=>{
 assert.equal(current.tasks.find(t=>t.id==='IBC-STABILITY').status,'in_progress');assert.equal(current.tasks.find(t=>t.id==='INJ-END-TO-END').status,'blocked');assert.equal(current.tasks.find(t=>t.id==='LIMITED-RELEASE').status,'blocked');
 assert.equal(current.executionPolicy.noAdministrativePolicyBypass,true);for(const t of current.tasks)for(const p of t.evidencePaths)assert.ok(fs.existsSync(new URL(p,root)),p);
});
