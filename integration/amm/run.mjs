#!/usr/bin/env node
/** Explicit auxiliary profile: passing a nightly test NEVER passes the pinned production gate. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {compilerProfileStatus} from './profile.mjs';
import {anvilStatus,verifiedAnvil} from '../anvil/toolchain.mjs';
import {sourceSnapshot,processEvidence} from '../../app/lib/acceptance.mjs';
import {isolatedServiceEnvironment} from '../../app/runtime.mjs';
import {need,safeError} from '../../wallet/lib/guard.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function parseArguments(args){
  need(args.length===2||args.length===4,'AMM_ARGUMENTS_INVALID');
  need(args[0]==='--output'&&typeof args[1]==='string'&&args[1].length>0,'AMM_OUTPUT_REQUIRED');
  const profile=args.length===4?args[3]:'pinned';
  need(args.length===2||args[2]==='--profile','AMM_ARGUMENTS_INVALID');
  need(['pinned','experimental'].includes(profile),'AMM_COMPILER_PROFILE_INVALID');
  return {output:path.resolve(args[1]),profile};
}
export function runAmm({output,profile='pinned',compiler,anvil}={}){
  need(typeof output==='string'&&output.length>0,'AMM_OUTPUT_REQUIRED');output=path.resolve(output);
  const tool=anvilStatus(anvil),compilerStatus=compilerProfileStatus(profile,compiler);
  need(!fs.existsSync(output),'AMM_OUTPUT_ALREADY_EXISTS');fs.mkdirSync(output,{recursive:true,mode:0o700});
  const report={schema:'realdex.amm-probe.v1',release:'0.12.0-dev.20260905',createdAt:new Date().toISOString(),status:'blocked',profile,compiler:compilerStatus,tool,
    solidityCompiled:false,allEvmScenariosPassed:false,baselineCompilerGateSatisfied:false,productionReady:false,
    experimentalOnly:profile==='experimental',publicNetworkContacted:false,realAssetsUsed:false,independentNodeConsensusTested:false,
    scope:'Actual unmodified AMM sources, throwaway local Anvil deployments; wallet-signed owner operations and bounded ERC20 agent payments. Test-deployer impersonation is fixture setup only.'};
  if(!tool.available||!compilerStatus.available)report.reason=!tool.available?tool.reason:compilerStatus.reason;
  else{
    const before=sourceSnapshot(root,{exclude:[output]}),fd=fs.openSync(path.join(output,'amm.tap'),'wx',0o600);
    const evidencePath=path.join(output,'compilation.json');let processResult;
    const env={...isolatedServiceEnvironment(),REALDEX_ANVIL_BINARY:verifiedAnvil(anvil),REALDEX_AMM_PROFILE:profile,REALDEX_AMM_EVIDENCE:evidencePath,
      [profile==='experimental'?'REALDEX_EXPERIMENTAL_SOLJSON':'REALDEX_SOLC_BINARY']:path.resolve(compiler)};
    try{processResult=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/amm/Settlement.test.mjs'],
      {cwd:root,env,stdio:['ignore',fd,fd],shell:false,timeout:180000});}finally{fs.closeSync(fd);}
    const log=fs.readFileSync(path.join(output,'amm.tap')),checked=processEvidence(processResult,log.toString('utf8'),{requireTap:true}),after=sourceSnapshot(root,{exclude:[output]});
    Object.assign(report,checked,{sourceDigest:before.digest,sourceStable:before.digest===after.digest,log:'amm.tap',logSha256:createHash('sha256').update(log).digest('hex')});
    if(fs.existsSync(evidencePath)){
      const bytes=fs.readFileSync(evidencePath),evidence=JSON.parse(bytes);
      report.solidityCompiled=evidence.profile===profile&&evidence.compilerSha256===compilerStatus.sha256;
      report.compilation={file:'compilation.json',sha256:createHash('sha256').update(bytes).digest('hex')};
    }
    if(!report.sourceStable||!report.solidityCompiled){report.status='failed';report.reason='AMM_SOURCE_OR_COMPILATION_EVIDENCE_INVALID';}
    report.allEvmScenariosPassed=report.status==='passed';report.baselineCompilerGateSatisfied=profile==='pinned'&&report.status==='passed';
  }
  fs.writeFileSync(path.join(output,'amm.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const options=parseArguments(process.argv.slice(2));const report=runAmm({...options,compiler:options.profile==='experimental'?process.env.REALDEX_EXPERIMENTAL_SOLJSON:process.env.REALDEX_SOLC_BINARY,anvil:process.env.REALDEX_ANVIL_BINARY});
    console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='passed'?0:report.status==='blocked'?2:1;
  }catch(e){console.error(safeError(e));process.exitCode=1;}
}
