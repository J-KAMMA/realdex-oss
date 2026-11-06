#!/usr/bin/env node
/** Fixed local diagnostic; API control never upgrades into browser/production certification. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {sourceIdentity,newOutput} from './identity.mjs';import {ApiDriver,PipeDriver} from './drivers.mjs';
import {runScenario} from './scenario.mjs';import {SCHEMA,need,sha,safeCode} from './protocol.mjs';
const ROOT=path.resolve(import.meta.dirname,'../..');
import {requireReferenceSource} from './reference-guard.mjs';
export function parseArgs(args){
 const c={};for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1],name={'--mode':'mode','--runtime-dir':'runtime','--output':'output','--expect-commit':'expectedCommit','--expect-tree':'expectedTree'}[k];need(name&&typeof v==='string'&&!v.startsWith('--')&&!Object.hasOwn(c,name),'E2E_ARGUMENTS');c[name]=v;}
 need(Object.keys(c).length===5&&['api','browser'].includes(c.mode),'E2E_ARGUMENTS');return c;
}
function codes(e){return e instanceof AggregateError?[safeCode(e),...e.errors.flatMap(codes)]:[safeCode(e)];}
export async function run(options){
 const before=sourceIdentity(ROOT,options);requireReferenceSource(ROOT);const output=newOutput(ROOT,options.output),start=Date.now();let result,driver;
 fs.writeFileSync(path.join(output,'source-before.json'),JSON.stringify(before,null,2)+'\n',{flag:'wx',mode:0o600});
 process.env.REALDEX_INJECTIVE_DIRECTORY=path.resolve(options.runtime);const progress=[];
 try{
  driver=options.mode==='browser'?new PipeDriver():new ApiDriver();
  result=await runScenario({driver,mode:options.mode,commit:before.commit,tree:before.tree,onStep:id=>{progress.push(id);fs.appendFileSync(path.join(output,'steps.ndjson'),JSON.stringify({id,index:progress.length})+'\n',{mode:0o600});}});
 }catch(e){const failures=codes(e);result={schema:SCHEMA,commit:before.commit,tree:before.tree,mode:options.mode,status:failures.includes('E2E_BROWSER_POLICY_BLOCK')?'blocked':'failed',errors:failures,checks:progress,browserEndToEndPassed:false,publicNetwork:false,productionReady:false,stateProofVerified:false};}
 try{const after=sourceIdentity(ROOT,options);need(after.digest===before.digest,'E2E_SOURCE_CHANGED');fs.writeFileSync(path.join(output,'source-after.json'),JSON.stringify(after,null,2)+'\n',{flag:'wx',mode:0o600});result.sourceStable=true;}
 catch(e){result.status='failed';result.errors=[...(result.errors??[]),safeCode(e)];result.sourceStable=false;result.browserEndToEndPassed=false;}
 result={...result,sourceDigest:before.digest,trackedFiles:before.trackedFiles,nodeVersion:process.versions.node,durationMs:Date.now()-start,createdAt:new Date().toISOString(),wholeProductAcceptance:false};
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 const files=fs.readdirSync(output).sort().map(name=>({path:name,sha256:sha(fs.readFileSync(path.join(output,name)))}));fs.writeFileSync(path.join(output,'FILES.json'),JSON.stringify(files,null,2)+'\n',{flag:'wx',mode:0o600});return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const r=await run(parseArgs(process.argv.slice(2)));console.log(JSON.stringify({status:r.status,mode:r.mode,commit:r.commit,checks:r.checks.length,sourceStable:r.sourceStable,browserEndToEndPassed:r.browserEndToEndPassed,errors:r.errors??[]}));process.exitCode=r.status==='passed'?0:r.status==='blocked'?2:1;}
 catch(e){console.error(safeCode(e));process.exitCode=1;}
}
