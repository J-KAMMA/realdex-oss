#!/usr/bin/env node
/** Executes actual HTTP authority cases. No arbitrary URL, wallet directory or selected subset. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {sourceIdentity,newOutput} from './identity.mjs';import {requireReferenceSource} from './reference-guard.mjs';
import {need,sha,safeCode} from './protocol.mjs';import {verifyRuntime} from './acceptance.mjs';
import {SCHEMA,FALSE_FLAGS,verifyAuthorityEvidence} from './authority-protocol.mjs';import {runAuthorityScenario} from './authority-scenario.mjs';
export function parseAuthorityArgs(args){
 const keys={'--runtime-dir':'runtime','--output':'output','--expect-commit':'expectedCommit','--expect-tree':'expectedTree'},o={};
 for(let i=0;i<args.length;i+=2){const k=keys[args[i]],v=args[i+1];need(k&&typeof v==='string'&&!v.startsWith('--')&&!Object.hasOwn(o,k),'E2E_AUTH_ARGUMENTS');o[k]=v;}
 need(Object.keys(o).length===4,'E2E_AUTH_ARGUMENTS');return o;
}
export async function runAuthority(o){
 const root=path.resolve(import.meta.dirname,'../..'),before=sourceIdentity(root,o);requireReferenceSource(root);
 const runtime=path.resolve(o.runtime),runtimeBefore=verifyRuntime(runtime),output=newOutput(root,o.output),started=Date.now();process.env.REALDEX_INJECTIVE_DIRECTORY=runtime;
 const put=(p,x)=>fs.writeFileSync(path.join(output,p),JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
 put('source-before.json',before);fs.writeFileSync(path.join(output,'steps.ndjson'),'',{flag:'wx',mode:0o600});let result;
 const codes=e=>e instanceof AggregateError?[safeCode(e),...e.errors.flatMap(codes)]:[safeCode(e)];
 try{result=await runAuthorityScenario({commit:before.commit,tree:before.tree,onStep:s=>fs.appendFileSync(path.join(output,'steps.ndjson'),JSON.stringify(s)+'\n')});}
 catch(e){result={schema:SCHEMA,mode:'api-authority',status:'failed',commit:before.commit,tree:before.tree,errors:codes(e),...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false]))};}
 try{const after=sourceIdentity(root,o);need(after.digest===before.digest,'E2E_AUTH_SOURCE_CHANGED');put('source-after.json',after);result.sourceStable=true;}catch(e){result.status='failed';result.sourceStable=false;result.errors=[...(result.errors??[]),...codes(e)];}
 try{need(JSON.stringify(verifyRuntime(runtime))===JSON.stringify(runtimeBefore),'E2E_AUTH_RUNTIME_CHANGED');result.runtimeStable=true;}catch(e){result.status='failed';result.runtimeStable=false;result.errors=[...(result.errors??[]),...codes(e)];}
 result={...result,createdAt:new Date().toISOString(),durationMs:Date.now()-started,sourceDigest:before.digest,trackedFiles:before.trackedFiles,nodeVersion:process.versions.node};
 if(result.status==='passed')verifyAuthorityEvidence(result,{expectedCommit:before.commit,expectedTree:before.tree});put('result.json',result);
 put('FILES.json',fs.readdirSync(output).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(output,p)))})));return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const r=await runAuthority(parseAuthorityArgs(process.argv.slice(2)));console.log(JSON.stringify({status:r.status,checks:r.checkCount??0,commit:r.commit,sourceStable:r.sourceStable,errors:r.errors??[]}));process.exitCode=r.status==='passed'?0:1;}
 catch(e){console.error(safeCode(e));process.exitCode=1;}
}
