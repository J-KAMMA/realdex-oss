#!/usr/bin/env node
/** Fast source CI only: no wallet credentials, network orders or deployment. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {CI_SUITES,suiteCommand} from './lib/ci-suites.mjs';
import {runPool,runProcess,testEnvironment} from './lib/parallel-process.mjs';
import {sourceSnapshot,processEvidence} from './lib/acceptance.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function parse(args){
  const options={jobs:3};for(let i=0;i<args.length;i++){
    const key=args[i];if(!['--suite','--output','--jobs'].includes(key)||Object.hasOwn(options,key))throw Error('CI_ARGUMENTS');
    const value=args[++i];if(!value||value.startsWith('--'))throw Error('CI_ARGUMENTS');options[key]=value;
  }
  if(!options['--output']||!options['--suite'])throw Error('CI_REQUIRES_SUITE_AND_OUTPUT');
  const suites=options['--suite']==='all'?[...CI_SUITES]:[options['--suite']];
  if(!suites.every(x=>CI_SUITES.includes(x)))throw Error('CI_UNKNOWN_SUITE');
  const jobs=options['--jobs']===undefined?3:Number(options['--jobs']);
  if(!Number.isSafeInteger(jobs)||jobs<1||jobs>4)throw Error('CI_CONCURRENCY_INVALID');
  return {output:path.resolve(options['--output']),suites,jobs};
}
async function main(){
  const {output,suites,jobs}=parse(process.argv.slice(2));
  if(fs.existsSync(output))throw Error('CI_OUTPUT_EXISTS');fs.mkdirSync(output,{recursive:true,mode:0o700});
  const before=sourceSnapshot(ROOT,{exclude:[output]});
  let commit=null,gitTreeClean=null;try{commit=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();gitTreeClean=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()==='';}catch{}
  fs.writeFileSync(path.join(output,'source-before.json'),JSON.stringify(before,null,2)+'\n');
  const controller=new AbortController();const interrupt=()=>controller.abort();
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  let results;
  try {
    results=await runPool(suites,async name=>{
      console.log('START '+name);const args=suiteCommand(ROOT,name),log=path.join(output,name+'.tap');
      const result=await runProcess({command:process.execPath,args,cwd:ROOT,log,signal:controller.signal,env:testEnvironment()});
      const bytes=fs.readFileSync(log),evidence=processEvidence(result,bytes.toString('utf8'),{requireTap:true});
      const receipt={schema:'realdex.ci-suite.v1',suite:name,scope:'source-tests; no public chain execution',commit,gitTreeClean,sourceDigest:before.digest,
        nodeVersion:process.versions.node,...result,...evidence,log:path.basename(log),logSha256:sha(bytes),
        productionReady:false,publicDeploymentPerformed:false};
      fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(receipt,null,2)+'\n');
      console.log('END '+name+' '+receipt.status);return receipt;
    },{concurrency:jobs,signal:controller.signal});
  } finally {process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
  const after=sourceSnapshot(ROOT,{exclude:[output]});fs.writeFileSync(path.join(output,'source-after.json'),JSON.stringify(after,null,2)+'\n');
  const unchanged=before.digest===after.digest,passed=unchanged&&results.length===suites.length&&results.every(r=>r.status==='passed');
  const countKeys=['tests','pass','fail','cancelled','skipped','todo'];
  const counts=Object.fromEntries(countKeys.map(k=>[k,results.reduce((sum,r)=>sum+(r.counts?.[k]??0),0)]));
  const summary={schema:'realdex.parallel-ci.v1',commit,gitTreeClean,sourceDigest:before.digest,sourceUnchanged:unchanged,maxConcurrentJobs:jobs,
    requestedSuites:suites,results,counts,passed,fullLocalAcceptancePassed:false,productionReady:false,
    notCovered:['root React build','formal compiler','chain VM integrations','public testnets','independent audit'],createdAt:new Date().toISOString()};
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({passed,counts,sourceUnchanged:unchanged,summary:path.join(output,'summary.json')}));process.exitCode=passed?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e instanceof Error?e.message:'CI_FAILED');process.exitCode=1;});
