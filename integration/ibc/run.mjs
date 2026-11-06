#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {ibcToolStatus} from './toolchain.mjs';
import {processEvidence,sourceSnapshot} from '../../app/lib/acceptance.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
try{
 const a=process.argv.slice(2);if(a.length!==2||a[0]!=='--output')throw Error('IBC_OUTPUT_ARGUMENT_REQUIRED');const output=path.resolve(a[1]);fs.mkdirSync(output,{recursive:false,mode:0o700});
 const tool=ibcToolStatus(),before=sourceSnapshot(root,{exclude:[output]});let evidence={status:'blocked',reason:tool.reason??null};
 if(tool.available){const env={PATH:process.env.PATH??'',HOME:process.env.HOME??'',LANG:'C',REALDEX_IBC_SIMD_BINARY:process.env.REALDEX_IBC_SIMD_BINARY,REALDEX_IBC_MUSL_LOADER:process.env.REALDEX_IBC_MUSL_LOADER,REALDEX_IBC_LOG_DIRECTORY:path.join(output,'nodes')};const fd=fs.openSync(path.join(output,'bridge.tap'),'wx',0o600);let result;try{result=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/ibc/Bridge.test.mjs','integration/ibc/Tracking.test.mjs','integration/ibc/Relay.test.mjs'],{cwd:root,env,stdio:['ignore',fd,fd],timeout:360000,shell:false});}finally{fs.closeSync(fd);}evidence=processEvidence(result,fs.readFileSync(path.join(output,'bridge.tap'),'utf8'),{requireTap:true});}
 const after=sourceSnapshot(root,{exclude:[output]}),report={schema:'realdex.ibc-acceptance.v1',createdAt:new Date().toISOString(),tool,evidence,sourceBefore:before.digest,sourceAfter:after.digest,sourceStable:before.digest===after.digest,plannedTopology:{separateChains:2,validatorsPerChain:1},runtimeAttempted:tool.available,runtimeExecuted:tool.available&&evidence.status==='passed',twoSeparateChains:tool.available&&evidence.status==='passed',validatorsPerChain:1,localObserverConsensusVerified:false,productionReady:false};
 report.passed=evidence.status==='passed'&&report.sourceStable;fs.writeFileSync(path.join(output,'ibc-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:2;
}catch(e){console.error(e.message);process.exitCode=1;}
