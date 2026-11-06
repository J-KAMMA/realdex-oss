#!/usr/bin/env node
/** E2E02 reference-only diagnostic. No user Vault, public network or browser-policy changes. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {sourceIdentity,newOutput} from './identity.mjs';import {CRASH_SCHEMA,verifyCrashEvidence} from './crash-protocol.mjs';
import {need,sha,safeCode} from './protocol.mjs';import {runCrashScenario} from './crash-scenario.mjs';
const ROOT=path.resolve(import.meta.dirname,'../..');
import {requireReferenceSource} from './reference-guard.mjs';
export {requireReferenceSource} from './reference-guard.mjs';
export function parseCrashArgs(args){
 const names={'--runtime-dir':'runtime','--output':'output','--expect-commit':'expectedCommit','--expect-tree':'expectedTree'},v={};
 for(let i=0;i<args.length;i+=2){need(names[args[i]]&&typeof args[i+1]==='string'&&!args[i+1].startsWith('--')&&!Object.hasOwn(v,names[args[i]]),'E2E_CRASH_ARGUMENTS');v[names[args[i]]]=args[i+1];}
 need(Object.keys(v).length===4,'E2E_CRASH_ARGUMENTS');return v;
}
export async function runCrash(options){
 const before=sourceIdentity(ROOT,options);requireReferenceSource(ROOT);const output=newOutput(ROOT,options.output);const started=Date.now(),progress=[];
 fs.writeFileSync(path.join(output,'source-before.json'),JSON.stringify(before,null,2)+'\n',{flag:'wx',mode:0o600});
 process.env.REALDEX_INJECTIVE_DIRECTORY=path.resolve(options.runtime);let result;
 const codes=e=>e instanceof AggregateError?[safeCode(e),...e.errors.flatMap(codes)]:[safeCode(e)];
 try{result=await runCrashScenario({commit:before.commit,tree:before.tree,onStep:p=>{progress.push(p);fs.appendFileSync(path.join(output,'steps.ndjson'),JSON.stringify(p)+'\n',{mode:0o600});}});}
 catch(e){result={schema:CRASH_SCHEMA,mode:'api-crash',commit:before.commit,tree:before.tree,status:'failed',errors:codes(e),progress,publicNetwork:false,productionReady:false,browserEndToEndPassed:false,checkpointCompatibilityVerified:false,productSuccessor:false};}
 try{const after=sourceIdentity(ROOT,options);need(after.digest===before.digest,'E2E_SOURCE_CHANGED');fs.writeFileSync(path.join(output,'source-after.json'),JSON.stringify(after,null,2)+'\n',{flag:'wx',mode:0o600});result.sourceStable=true;}
 catch(e){result.status='failed';result.sourceStable=false;result.errors=[...(result.errors??[]),safeCode(e)];}
 if(result.status==='passed')verifyCrashEvidence(result,{expectedCommit:before.commit,expectedTree:before.tree});
 result={...result,createdAt:new Date().toISOString(),durationMs:Date.now()-started,sourceDigest:before.digest,trackedFiles:before.trackedFiles,nodeVersion:process.versions.node};
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 const files=fs.readdirSync(output).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(output,p)))}));fs.writeFileSync(path.join(output,'FILES.json'),JSON.stringify(files,null,2)+'\n',{flag:'wx',mode:0o600});return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const r=await runCrash(parseCrashArgs(process.argv.slice(2)));console.log(JSON.stringify({status:r.status,checkCount:r.checkCount??r.progress?.length,commit:r.commit,sourceStable:r.sourceStable,errors:r.errors??[]}));process.exitCode=r.status==='passed'?0:1;}
 catch(e){console.error(safeCode(e));process.exitCode=1;}
}
