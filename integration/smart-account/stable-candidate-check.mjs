#!/usr/bin/env node
/** Offline/source binding check; with --compiler also recompiles using pinned solc. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import evidence from './stable-candidate-evidence.json' with {type:'json'};
import {verifyCandidate,replayCandidate} from './stable-candidate.mjs';
import {need,safeError} from '../../wallet/lib/guard.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function parse(argv){const out={};for(let i=0;i<argv.length;i+=2){need(argv[i]?.startsWith('--')&&argv[i+1],'SMART_STABLE_CHECK_ARGUMENTS_INVALID');out[argv[i].slice(2)]=argv[i+1];}need(out.candidate,'SMART_STABLE_CHECK_ARGUMENTS_INVALID');return out;}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const a=parse(process.argv.slice(2)),bytes=fs.readFileSync(path.resolve(a.candidate)),candidate=JSON.parse(bytes);
  verifyCandidate(candidate,{expectedBuildInfoSha256:evidence.buildInfoSha256});
  const report={schema:'realdex.smart-account-stable-candidate-check.v1',candidateSha256:sha(bytes),sourceBound:true,stableCompilerIdentity:true,stableCompilerReplay:false,independentReviewComplete:false,productionApproved:false};
  if(a.compiler){Object.assign(report,{stableCompilerReplay:true,replay:replayCandidate(candidate,{compiler:path.resolve(a.compiler)})});}
  console.log(JSON.stringify(report,null,2));
 }catch(e){console.error(safeError(e));process.exitCode=1;}
}
