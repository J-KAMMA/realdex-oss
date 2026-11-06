#!/usr/bin/env node
/** Reproducible real-EVM native payment gate. Missing executable is blocked, never skipped/passed. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {anvilStatus,verifiedAnvil} from './toolchain.mjs';
import {sourceSnapshot,processEvidence} from '../../app/lib/acceptance.mjs';
import {isolatedServiceEnvironment} from '../../app/runtime.mjs';
import {need,safeError} from '../../wallet/lib/guard.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
try {
  const args=process.argv.slice(2);need(args.length===2&&args[0]==='--output','ANVIL_RUN_REQUIRES_OUTPUT');
  const output=path.resolve(args[1]);need(!fs.existsSync(output),'ANVIL_OUTPUT_ALREADY_EXISTS');fs.mkdirSync(output,{recursive:true,mode:0o700});
  const tool=anvilStatus(process.env.REALDEX_ANVIL_BINARY);
  const report={schema:'realdex.anvil-native.v1',release:'0.12.0-dev.20260905',createdAt:new Date().toISOString(),status:'blocked',tool,
    realEvmExecuted:false,publicNetworkContacted:false,realAssetsUsed:false,productionReady:false,
    scope:'native payments and bounded AI policy on a single real Anvil process, with two forwarding transports',
    solidityCompiled:false,ammContractsExecuted:false,independentNodeConsensusTested:false};
  if(tool.available) {
    const before=sourceSnapshot(root,{exclude:[output]});
    const log=path.join(output,'native-payments.tap'),fd=fs.openSync(log,'wx',0o600);
    let result;
    try {result=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/anvil/NativePayments.test.mjs'],
      {cwd:root,env:{...isolatedServiceEnvironment(),REALDEX_ANVIL_BINARY:verifiedAnvil(process.env.REALDEX_ANVIL_BINARY)},stdio:['ignore',fd,fd],timeout:180000,shell:false});}
    finally {fs.closeSync(fd);}
    const bytes=fs.readFileSync(log),evidence=processEvidence(result,bytes.toString('utf8'),{requireTap:true});
    const after=sourceSnapshot(root,{exclude:[output]});
    Object.assign(report,evidence,{sourceDigest:before.digest,sourceStable:before.digest===after.digest,
      logSha256:createHash('sha256').update(bytes).digest('hex'),log:'native-payments.tap',realEvmExecuted:evidence.status==='passed'});
    if(!report.sourceStable){report.status='failed';report.reason='SOURCE_CHANGED_DURING_ANVIL_TEST';}
  } else report.reason=tool.reason;
  fs.writeFileSync(path.join(output,'anvil-native.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='passed'?0:report.status==='blocked'?2:1;
} catch(e) {console.error(safeError(e));process.exitCode=1;}
