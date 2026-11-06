#!/usr/bin/env node
/** E2E04: strict reference-only local concurrency runner, not a product release or production recovery. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {sourceIdentity,newOutput} from './identity.mjs';import {requireReferenceSource} from './run-crash.mjs';
import {need,sha,safeCode} from './protocol.mjs';import {SCHEMA,FALSE_FLAGS,verifyConcurrencyEvidence} from './concurrency-protocol.mjs';
import {runConcurrencyScenario} from './concurrency-scenario.mjs';
export function parseConcurrencyArgs(args){
 const map={'--runtime-dir':'runtime','--output':'output','--expect-commit':'expectedCommit','--expect-tree':'expectedTree'},v={};
 for(let i=0;i<args.length;i+=2){need(map[args[i]]&&typeof args[i+1]==='string'&&!args[i+1].startsWith('--')&&!Object.hasOwn(v,map[args[i]]),'E2E_CONCURRENCY_ARGS');v[map[args[i]]]=args[i+1];}
 need(Object.keys(v).length===4,'E2E_CONCURRENCY_ARGS');return v;
}
export async function runConcurrency(o){
 const root=path.resolve(import.meta.dirname,'../..'),before=sourceIdentity(root,o);requireReferenceSource(root);
 const output=newOutput(root,o.output),started=Date.now(),progress=[];process.env.REALDEX_INJECTIVE_DIRECTORY=path.resolve(o.runtime);
 fs.writeFileSync(path.join(output,'source-before.json'),JSON.stringify(before,null,2)+'\n',{flag:'wx',mode:0o600});let result;
 const codes=e=>e instanceof AggregateError?[safeCode(e),...e.errors.flatMap(codes)]:[safeCode(e)];
 try{result=await runConcurrencyScenario({commit:before.commit,tree:before.tree,onStep:p=>{progress.push(p);fs.appendFileSync(path.join(output,'steps.ndjson'),JSON.stringify(p)+'\n',{mode:0o600});}});}
 catch(e){result={schema:SCHEMA,mode:'api-concurrency',commit:before.commit,tree:before.tree,status:'failed',errors:codes(e),progress,...Object.fromEntries(FALSE_FLAGS.map(x=>[x,false]))};}
 try{const after=sourceIdentity(root,o);need(after.digest===before.digest,'E2E_SOURCE_CHANGED');fs.writeFileSync(path.join(output,'source-after.json'),JSON.stringify(after,null,2)+'\n',{flag:'wx',mode:0o600});result.sourceStable=true;}
 catch(e){result.status='failed';result.sourceStable=false;result.errors=[...(result.errors??[]),safeCode(e)];}
 if(result.status==='passed')verifyConcurrencyEvidence(result,{expectedCommit:before.commit,expectedTree:before.tree});
 result={...result,createdAt:new Date().toISOString(),durationMs:Date.now()-started,sourceDigest:before.digest,trackedFiles:before.trackedFiles,nodeVersion:process.versions.node};
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(output,'FILES.json'),JSON.stringify(fs.readdirSync(output).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(output,p)))})),null,2)+'\n',{flag:'wx',mode:0o600});return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const r=await runConcurrency(parseConcurrencyArgs(process.argv.slice(2)));console.log(JSON.stringify({status:r.status,checkCount:r.checkCount??r.progress?.length,errors:r.errors??[],commit:r.commit,sourceStable:r.sourceStable}));process.exitCode=r.status==='passed'?0:1;}
 catch(e){console.error(safeCode(e));process.exitCode=1;}
}
