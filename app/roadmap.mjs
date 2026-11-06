#!/usr/bin/env node
/** Read-only plan inspection. A planned state never authorizes deployment or signing. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {need} from '../wallet/lib/guard.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function inspectRoadmap(plan) {
  need(plan?.schema==='realdex.development-roadmap.v1'&&plan.productionReady===false&&plan.statusIsPlanNotAttestation===true,'ROADMAP_SCHEMA');
  need(Array.isArray(plan.tasks)&&plan.tasks.length>0&&plan.tasks.length<=128,'ROADMAP_TASKS');
  const byId=new Map();
  for(const t of plan.tasks){
    need(t&&/^[A-Z][A-Z0-9-]{1,32}$/.test(t.id)&&!byId.has(t.id),'ROADMAP_ID');
    need(['planned','in_progress','implemented_local','externally_verified'].includes(t.state)&&['P0','P1','P2'].includes(t.priority),'ROADMAP_STATE');
    need(typeof t.title==='string'&&t.title.length>0&&Array.isArray(t.dependsOn)&&new Set(t.dependsOn).size===t.dependsOn.length,'ROADMAP_DEPENDENCIES');
    need(Array.isArray(t.acceptance)&&t.acceptance.length>0&&t.acceptance.every(x=>typeof x==='string'&&x.length>0),'ROADMAP_ACCEPTANCE');
    byId.set(t.id,t);
  }
  for(const t of plan.tasks){need(t.releaseRequires===undefined||Array.isArray(t.releaseRequires)&&new Set(t.releaseRequires).size===t.releaseRequires.length&&t.releaseRequires.every(x=>byId.has(x)&&x!==t.id),'ROADMAP_RELEASE_DEPENDENCY');}
  const external=plan.externalCandidates??[];need(Array.isArray(external)&&external.length<=32,'ROADMAP_CANDIDATE');const providerIds=new Set();
  for(const c of external){need(c&&typeof c.id==='string'&&!providerIds.has(c.id)&&byId.has(c.task),'ROADMAP_CANDIDATE');providerIds.add(c.id);need(c.executionAuthorized===false,'ROADMAP_AUTHORITY');}
  const visiting=new Set(),done=new Set(),ordered=[];
  function visit(id){need(byId.has(id),'ROADMAP_MISSING_DEPENDENCY');need(!visiting.has(id),'ROADMAP_CYCLE');if(done.has(id))return;visiting.add(id);for(const dep of byId.get(id).dependsOn)visit(dep);visiting.delete(id);done.add(id);ordered.push(id);}
  for(const id of byId.keys())visit(id);
  const incomplete=t=>!['implemented_local','externally_verified'].includes(t.state);
  const tasks=ordered.map(id=>{const t=byId.get(id),waitingFor=t.dependsOn.filter(d=>incomplete(byId.get(d)));return {id,title:t.title,priority:t.priority,state:t.state,waitingFor,releaseWaitingFor:(t.releaseRequires??[]).filter(id=>byId.get(id).state!=='externally_verified'),delivered:t.delivered??[],authorizesExecution:false,readyToWork:incomplete(t)&&waitingFor.length===0};});
  return {schema:'realdex.roadmap-inspection.v1',baseline:plan.baseline,revision:plan.revision,externalCandidates:external,nextWork:plan.nextWork,tasks,readyToWork:tasks.filter(t=>t.readyToWork).map(t=>t.id),productionReady:false,authorizesExecution:false,statesAreDeclaredNotAudited:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{need(process.argv.slice(2).length===0,'ROADMAP_ARGUMENTS');const p=JSON.parse(fs.readFileSync(path.join(root,'plans/DEVELOPMENT-ROADMAP-2026-09-06.json'),'utf8'));console.log(JSON.stringify(inspectRoadmap(p),null,2));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
