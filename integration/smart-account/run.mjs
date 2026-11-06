#!/usr/bin/env node
/** Explicit auxiliary gate. A passing experimental smart-account test is never mainnet approval. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {compilerProfileStatus} from '../amm/profile.mjs';
import {anvilStatus,verifiedAnvil} from '../anvil/toolchain.mjs';
import {sourceSnapshot,processEvidence} from '../../app/lib/acceptance.mjs';
import {isolatedServiceEnvironment} from '../../app/runtime.mjs';
import {need,safeError} from '../../wallet/lib/guard.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
export function parseArguments(args){need(args.length===2&&args[0]==='--output'&&args[1]?.length>0,'SMART_TEST_OUTPUT_REQUIRED');return {output:path.resolve(args[1])};}
export function runSmart({output,compiler,anvil}={}){
  need(typeof output==='string'&&output.length>0,'SMART_TEST_OUTPUT_REQUIRED');output=path.resolve(output);need(!fs.existsSync(output),'SMART_TEST_OUTPUT_EXISTS');fs.mkdirSync(output,{recursive:true,mode:0o700});
  const tool=anvilStatus(anvil),comp=compilerProfileStatus('experimental',compiler);
  const report={schema:'realdex.smart-account-probe.v1',release:'0.19.0-dev.20260906',createdAt:new Date().toISOString(),status:'blocked',compiler:comp,tool,
    sourceStable:false,artifactRecompiledAndMatched:false,experimentalOnly:true,stableCompilerGateSatisfied:false,productionReady:false,
    erc4337:false,eip7702:false,publicNetworkContacted:false,realAssetsUsed:false,independentNodeConsensusTested:false};
  if(!tool.available||!comp.available)report.reason=!tool.available?tool.reason:comp.reason;
  else{
    const before=sourceSnapshot(ROOT,{exclude:[output]}),fd=fs.openSync(path.join(output,'smart-account.tap'),'wx',0o600);
    const env={...isolatedServiceEnvironment(),REALDEX_ANVIL_BINARY:verifiedAnvil(anvil),REALDEX_EXPERIMENTAL_SOLJSON:path.resolve(compiler)};let result;
    try{result=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/smart-account/SmartAccount.test.mjs'],{cwd:ROOT,env,stdio:['ignore',fd,fd],timeout:300000,shell:false});}finally{fs.closeSync(fd);}
    const bytes=fs.readFileSync(path.join(output,'smart-account.tap')),evidence=processEvidence(result,bytes.toString(),{requireTap:true}),after=sourceSnapshot(ROOT,{exclude:[output]});
    Object.assign(report,evidence,{sourceStable:before.digest===after.digest,sourceDigest:before.digest,artifactSha256:sha(fs.readFileSync(path.join(ROOT,'wallet/smart-account/build.json'))),log:'smart-account.tap',logSha256:sha(bytes)});
    report.artifactRecompiledAndMatched=report.status==='passed'&&/ok 1 - fresh compilation exactly reproduces the delivered smart-account artifact/.test(bytes.toString());
    if(!report.sourceStable||!report.artifactRecompiledAndMatched){report.status='failed';report.reason='SMART_TEST_SOURCE_OR_COMPILATION_MISMATCH';}
    fs.writeFileSync(path.join(output,'source-before.json'),JSON.stringify(before,null,2)+'\n',{flag:'wx',mode:0o600});
    fs.writeFileSync(path.join(output,'source-after.json'),JSON.stringify(after,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  fs.writeFileSync(path.join(output,'smart-account.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const r=runSmart({...parseArguments(process.argv.slice(2)),compiler:process.env.REALDEX_EXPERIMENTAL_SOLJSON,anvil:process.env.REALDEX_ANVIL_BINARY});console.log(JSON.stringify(r,null,2));process.exitCode=r.status==='passed'?0:r.status==='blocked'?2:1;}catch(e){console.error(safeError(e));process.exitCode=1;}
}
