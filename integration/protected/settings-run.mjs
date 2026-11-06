#!/usr/bin/env node
/** UP02: exact-source product CLI/configuration/local-node acceptance. No public network or UI simulation. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {sourceIdentity,newOutput} from '../owner-e2e/identity.mjs';import {verifyRuntime} from '../owner-e2e/acceptance.mjs';import {sha,need} from '../owner-e2e/protocol.mjs';
import {runSettingsLifecycle} from './settings-lifecycle.mjs';import {runSettingsCli} from './settings-cli.mjs';
async function main(){
 const keys={'--runtime-dir':'runtime','--output':'output','--expect-commit':'expectedCommit','--expect-tree':'expectedTree'},o={},a=process.argv.slice(2);
 for(let i=0;i<a.length;i+=2){const k=keys[a[i]],v=a[i+1];need(k&&v&&!v.startsWith('--')&&!Object.hasOwn(o,k),'E2E_UP02_ARGUMENTS');o[k]=v;}
 need(Object.keys(o).length===4,'E2E_UP02_ARGUMENTS');const root=path.resolve(import.meta.dirname,'../..'),before=sourceIdentity(root,o),runtime=path.resolve(o.runtime),pin=verifyRuntime(runtime),out=newOutput(root,o.output);
 process.env.REALDEX_INJECTIVE_DIRECTORY=runtime;const start=Date.now(),put=(n,v)=>fs.writeFileSync(path.join(out,n),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
 put('source-before.json',before);fs.writeFileSync(path.join(out,'steps.ndjson'),'',{flag:'wx',mode:0o600});
 const result={schema:'realdex.up02-acceptance.v1',commit:before.commit,tree:before.tree,configurationPassed:false,browserTested:false,publicNetwork:false,productionReady:false};
 try{
  const cli=await runSettingsCli();put('product-cli.json',cli);
  const lifecycle=await runSettingsLifecycle({onStep:step=>fs.appendFileSync(path.join(out,'steps.ndjson'),JSON.stringify({step})+'\n')});put('lifecycle.json',lifecycle);
  result.configurationPassed=cli.passed&&lifecycle.passed;
 }catch(e){result.error=e instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'E2E_UP02_FAILED';}
 try{const after=sourceIdentity(root,o);put('source-after.json',after);result.sourceStable=after.digest===before.digest;}catch{result.sourceStable=false;}
 try{result.runtimeStable=JSON.stringify(verifyRuntime(runtime))===JSON.stringify(pin);}catch{result.runtimeStable=false;}
 result.configurationPassed&&=result.sourceStable&&result.runtimeStable;result.durationMs=Date.now()-start;result.nodeVersion=process.versions.node;put('result.json',result);
 const checked=spawnSync('python3',['-I','-S',path.join(import.meta.dirname,'check-settings.py'),out],{encoding:'utf8',timeout:10000,shell:false});
 fs.writeFileSync(path.join(out,'independent-check.log'),(checked.stdout??'')+(checked.stderr??''),{flag:'wx',mode:0o600});
 put('FILES.json',fs.readdirSync(out).sort().map(n=>({path:n,sha256:sha(fs.readFileSync(path.join(out,n)))})));
 const passed=result.configurationPassed&&checked.status===0&&!checked.signal&&!checked.error;
 console.log(JSON.stringify({passed,...result,independentCheckPassed:checked.status===0}));process.exitCode=passed?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{await main();}catch(e){console.error(/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'E2E_UP02_RUN_FAILED');process.exitCode=1;}
