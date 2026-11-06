#!/usr/bin/env node
/** Fixed UP01 integrated API/storage scope. Browser outcome is separate; never bypass management policy. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {sourceIdentity,newOutput} from '../owner-e2e/identity.mjs';import {verifyRuntime} from '../owner-e2e/acceptance.mjs';
import {ApiDriver} from '../owner-e2e/drivers.mjs';import {sha,need} from '../owner-e2e/protocol.mjs';
import {runProtectedRoundtrip} from './roundtrip.mjs';import {runProtectedRecovery} from './recovery.mjs';
const root=path.resolve(import.meta.dirname,'../..');
async function main(){
 const keys={'--runtime-dir':'runtime','--output':'output','--expect-commit':'expectedCommit','--expect-tree':'expectedTree'},args=process.argv.slice(2),o={};
 for(let i=0;i<args.length;i+=2){const k=keys[args[i]],v=args[i+1];need(k&&v&&!v.startsWith('--')&&!Object.hasOwn(o,k),'E2E_CP_ARGUMENTS');o[k]=v;}
 need(Object.keys(o).length===4,'E2E_CP_ARGUMENTS');
 const before=sourceIdentity(root,o),runtime=path.resolve(o.runtime),pin=verifyRuntime(runtime),out=newOutput(root,o.output);
 process.env.REALDEX_INJECTIVE_DIRECTORY=runtime;const started=Date.now();
 const put=(n,x)=>fs.writeFileSync(path.join(out,n),JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
 put('source-before.json',before);
 fs.writeFileSync(path.join(out,'steps.ndjson'),'',{flag:'wx',mode:0o600});
 const onStep=x=>fs.appendFileSync(path.join(out,'steps.ndjson'),JSON.stringify(x)+'\n');
 let r={schema:'realdex.protected-integration.v1',commit:before.commit,tree:before.tree,apiPassed:false,browserPassed:false,productionReady:false,legacyInj13Compatible:false,publicNetwork:false};
 try{
  r.roundtrip=await runProtectedRoundtrip({driver:new ApiDriver(),mode:'api',commit:before.commit,tree:before.tree,onStep:x=>onStep({roundtrip:x})});
  r.recovery=await runProtectedRecovery({onStep,output:out});
  r.apiPassed=true;r.browserPassed=r.recovery.cases[1].browser.passed;
 }catch(e){r.error=e instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'E2E_CP_INTEGRATION_FAILED';}
 try{const after=sourceIdentity(root,o);put('source-after.json',after);r.sourceStable=after.digest===before.digest;}catch{r.sourceStable=false;}
 try{r.runtimeStable=JSON.stringify(verifyRuntime(runtime))===JSON.stringify(pin);}catch{r.runtimeStable=false;}
 r.apiPassed=r.apiPassed&&r.sourceStable&&r.runtimeStable;r.sourceDigest=before.digest;r.trackedFiles=before.trackedFiles;r.durationMs=Date.now()-started;r.nodeVersion=process.versions.node;
 put('result.json',r);
 const seal=()=>fs.writeFileSync(path.join(out,'FILES.json'),JSON.stringify(fs.readdirSync(out).filter(n=>n!=='FILES.json').sort().map(n=>({path:n,sha256:sha(fs.readFileSync(path.join(out,n)))})),null,2)+'\n',{mode:0o600});
 seal();
 const ref=spawnSync('python3',['-I','-S',path.join(import.meta.dirname,'check-evidence.py'),'--directory',out],{encoding:'utf8',timeout:15000,shell:false});
 fs.writeFileSync(path.join(out,'independent-check.log'),(ref.stdout??'')+(ref.stderr??''),{flag:'wx',mode:0o600});seal();
 const passed=r.apiPassed&&ref.status===0&&!ref.signal&&!ref.error;
 console.log(JSON.stringify({apiPassed:passed,browserPassed:r.browserPassed,browserError:r.recovery?.cases[1]?.browser?.error??null,roundtripChecks:r.roundtrip?.checks.length??0,recoveryChecks:r.recovery?.checkCount??0,sourceStable:r.sourceStable,runtimeStable:r.runtimeStable,error:r.error??null,productionReady:false}));
 process.exitCode=passed?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{await main();}catch(e){console.error(e instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'E2E_CP_RUN_FAILED');process.exitCode=1;}
