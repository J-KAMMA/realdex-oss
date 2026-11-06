import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..'),name='plans/LOCAL-COMPLETION-2026-09-07';
const plan=JSON.parse(fs.readFileSync(path.join(root,name+'.json'),'utf8')),md=fs.readFileSync(path.join(root,name+'.md'),'utf8');
test('Local roadmap pins INJ08 provenance and never treats its plan as production certification',()=>{
 assert.equal(plan.schema,'realdex.local-completion-roadmap.v1');assert.equal(plan.baseline.commit,'0cde56d8877d9fce8638cfcd041e74ede4c9bd99');
 assert.equal(plan.baseline.sha256,'08f3efacd6e12b044d7a1491517ee78748afb21c26aeb8a3e4c4b829208318c1');assert.equal(plan.githubUsed,false);assert.equal(plan.automaticPublication,false);assert.equal(plan.productionReady,false);assert.equal(plan.planIsNotCertification,true);assert.equal(plan.completionPercentage,null);
});
test('Every local completion task has explicit acceptance and acyclic existing dependencies',()=>{
 const ids=plan.tasks.map(t=>t.id);assert.equal(new Set(ids).size,ids.length);const visiting=new Set(),done=new Set();
 function visit(id){assert.ok(ids.includes(id));assert.ok(!visiting.has(id));if(done.has(id))return;visiting.add(id);const t=plan.tasks.find(t=>t.id===id);t.dependsOn.forEach(visit);visiting.delete(id);done.add(id);}
 for(const t of plan.tasks){assert.ok(['P0','P1','P2'].includes(t.priority));assert.ok(['verified_local','in_progress','blocked','planned'].includes(t.status));assert.ok(t.acceptance.length>=2&&t.acceptance.every(x=>typeof x==='string'&&x.length>0));assert.ok(t.remaining.length>0);visit(t.id);}
});
test('Roadmap evidence paths exist and describe local source, not invented remote results',()=>{
 assert.ok(fs.existsSync(path.join(root,plan.originalRoadmap)));
 for(const t of plan.tasks){if(t.status==='verified_local')assert.ok(t.evidencePaths.length>0);for(const p of t.evidencePaths){assert.ok(!path.isAbsolute(p)&&!p.split('/').includes('..'));assert.ok(fs.existsSync(path.join(root,p)),p);}}
 assert.equal(plan.tasks.find(t=>t.id==='LIMITED-RELEASE').status,'blocked');assert.equal(plan.tasks.find(t=>t.id==='INJ-END-TO-END').status,'blocked');
});
test('Human roadmap preserves task IDs, no policy bypass, and wallet continuity warning',()=>{
 for(const t of plan.tasks)assert.ok(md.includes(t.id));assert.equal(plan.executionPolicy.noAdministrativePolicyBypass,true);
 const html=fs.readFileSync(path.join(root,'wallet/public/index.html'),'utf8');assert.ok(html.includes('id="injectiveContinuityNotice"'));assert.ok(html.includes('古いバックアップへの差替えで解除せず'));assert.ok(md.includes('限定公開')&&md.includes('全構想'));
});
