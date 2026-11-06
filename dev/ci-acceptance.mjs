#!/usr/bin/env node
/** Development CI is NOT full acceptance. The original full verifier stays unchanged. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {ROOT_GATES,processEvidence,sourceSnapshot} from '../app/lib/acceptance.mjs';
import {rootScriptPlan} from '../app/lib/root-script-plan.mjs';
import {frameworkEvidence} from '../app/lib/framework-evidence.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const digest=/^[a-f0-9]{64}$/;
const check=(ok,code)=>{if(!ok)throw Error(code);};
export const REQUIRED=Object.freeze(['wallet-tests','node-tests','external-spot-tests','app-tests','relay-tests',...ROOT_GATES,
  'native-real-evm','amm-pinned-real-evm','smart-account-stable-candidate-evm','local-compilation','browser-http','source-stability','runtime-configuration']);
// Exact known unprovisioned/review conditions only. Corrupt tools and policy blocks are NOT exempt.
export const DEFERRED=Object.freeze({
  'smart-account-stable-build':'SMART_ACCOUNT_STABLE_COMPILER_REVIEW_PENDING',
  // The digest is now pinned and verified, so an unprovisioned machine blocks on the runtime instead.
  'stellar-core-runtime':'STELLAR_CONTAINER_RUNTIME_NOT_CONFIGURED',
  'solana-native-runtime':'SOLANA_TEST_ARCHIVE_NOT_CONFIGURED',
  'solana-spl-runtime':'SOLANA_TEST_ARCHIVE_NOT_CONFIGURED',
  'bitcoin-core-regtest':'BITCOIND_NOT_CONFIGURED',
  'cosmos-simd-runtime':'SIMD_NOT_CONFIGURED',
  'cosmos-authz-runtime':'SIMD_NOT_CONFIGURED',
  'aptos-local-runtime':'APTOS_NOT_CONFIGURED',
  'ibc-two-chain-runtime':'IBC_BINARY_NOT_CONFIGURED',
  'ibc-tracking-runtime':'IBC_BINARY_NOT_CONFIGURED',
  'ibc-relay-runtime':'IBC_BINARY_NOT_CONFIGURED',
  // Two independent public readers observing the deployment the committed profile names.
  // Read-only — no key, no signing, no submission — but it reaches the public internet,
  // so the operator has to ask for it with REALDEX_PUBLIC_NETWORK_READS=1. Without that
  // it blocks here with a stated reason rather than being silently absent.
  //
  // It used to be a test inside root-ui-tests, skipped on REALDEX_LIVE, which meant that
  // gate always carried one pending test and so could never pass. Moving it out is not a
  // pending being excluded to make a count come out right: the thing that was invisible
  // in a summary is now a gate with a name, a reason and a recorded result.
  'public-testnet-readers':'PUBLIC_NETWORK_READS_NOT_ENABLED'
});
// Locally provisioned runtimes only. The public reader gate is not one: it depends on
// somebody else's endpoints being up, which is not a property of this machine.
const NOT_LOCAL_RUNTIME=['smart-account-stable-build','stellar-core-runtime','public-testnet-readers'];
export const RUNTIME_GATES=Object.freeze(Object.keys(DEFERRED).filter(x=>!NOT_LOCAL_RUNTIME.includes(x)));
const ALL=Object.freeze([...REQUIRED,...Object.keys(DEFERRED)]);
const COUNT_KEYS=['tests','pass','fail','cancelled','skipped','todo'];
const TAP=new Set(['wallet-tests','node-tests','external-spot-tests','app-tests','relay-tests','root-release-plan','native-real-evm','amm-pinned-real-evm','smart-account-stable-candidate-evm',
  ...Object.keys(DEFERRED).filter(x=>!['smart-account-stable-build','public-testnet-readers'].includes(x))]);
const FRAMEWORKS=Object.freeze({'root-contract-tests':'mocha','root-ui-tests':'vitest','real-evm-wallet-integration':'mocha','public-testnet-readers':'vitest'});
const METADATA=new Set(['root-script-declarations','root-package-manager']);
function validSnapshot(s){
  check(s?.schema==='realdex.source-snapshot.v1'&&Array.isArray(s.files)&&s.files.length>0,'CI_SNAPSHOT_INVALID');
  check(digest.test(s.digest)&&hash(JSON.stringify(s.files))===s.digest,'CI_SNAPSHOT_HASH');
  let last='';for(const f of s.files){
    check(typeof f.path==='string'&&f.path>last&&!f.path.startsWith('/')&&!f.path.split('/').includes('..')&&Number.isSafeInteger(f.size)&&f.size>=0&&digest.test(f.sha256),'CI_SNAPSHOT_FILE');last=f.path;
  }
  return s.digest;
}
/** Reads only evidence explicitly named by the immutable report. Throws on malformed evidence. */
export function evaluateAcceptance(report,{profile='strict',execution,expectedDigest,before,after,readLog,readSource}={}){
  check(['development','runtime','strict'].includes(profile),'CI_PROFILE_INVALID');
  check(report?.schema==='realdex.acceptance.v2'&&report.fullRequested===true&&['solana','bitcoin','cosmos','aptos','ibc'].every(x=>report[x+'Requested']===true),'CI_FULL_REPORT_REQUIRED');
  check(report.productionReady===false&&report.publicDeploymentPerformed===false,'CI_APPROVAL_FORBIDDEN');
  check(digest.test(expectedDigest)&&report.sourceDigest===expectedDigest&&validSnapshot(before)===expectedDigest&&validSnapshot(after)===expectedDigest,'CI_SOURCE_MISMATCH');
  check(Array.isArray(report.gates)&&report.gates.length===ALL.length,'CI_GATE_SET');
  let manifest;
  try{
    const row=before.files.find(file=>file.path==='package.json'),bytes=readSource?.('package.json');
    check(row&&Buffer.isBuffer(bytes)&&bytes.length===row.size&&hash(bytes)===row.sha256,'CI_SOURCE_MANIFEST');
    manifest=JSON.parse(bytes.toString('utf8'));
    check(manifest&&typeof manifest==='object'&&!Array.isArray(manifest),'CI_SOURCE_MANIFEST');
  }catch{throw Error('CI_SOURCE_MANIFEST');}
  const seen=new Set(),failed=[],blocked=[],passed=[];
  const total=Object.fromEntries(COUNT_KEYS.map(k=>[k,0]));
  for(const g of report.gates){
    check(g&&ALL.includes(g.name)&&!seen.has(g.name),'CI_GATE_SET');seen.add(g.name);
    check(['passed','failed','blocked'].includes(g.status),'CI_GATE_STATUS');
    if(g.name==='source-stability'){
      check(g.before===expectedDigest&&g.after===expectedDigest&&g.status==='passed','CI_SOURCE_CHANGED');
    }else if(g.name==='runtime-configuration'){
      check(Array.isArray(g.problems)&&g.status==='passed'&&g.problems.length===0,'CI_RUNTIME_CONFIGURATION');
    }else{
      check(g.sourceDigest===expectedDigest,'CI_GATE_SOURCE_MISMATCH');
      if(g.status==='blocked'){
        check(Object.hasOwn(DEFERRED,g.name)&&g.reason===DEFERRED[g.name],'CI_UNEXPECTED_BLOCK');
        check(!['exitCode','signal','counts','log','logSha256'].some(k=>Object.hasOwn(g,k)),'CI_EXECUTED_BLOCK');
        blocked.push({name:g.name,status:'blocked',reason:g.reason});continue;
      }
      if(METADATA.has(g.name)){
        const code=g.name==='root-script-declarations'?'CI_ROOT_DECLARATIONS':'CI_PACKAGE_MANAGER';
        check(!['exitCode','signal','counts','log','logSha256'].some(key=>Object.hasOwn(g,key)),code);
        if(g.status==='passed'){
          check(!g.reason,code);
          if(g.name==='root-script-declarations'){
            let scripts;try{scripts=rootScriptPlan(manifest).map(item=>item.script);}catch{throw Error(code);}
            check(JSON.stringify(g.scripts)===JSON.stringify(scripts),code);
          }else{
            const keys=['available','version','cli','cliSha256','packageManifestSha256','autoInstallPerformed'];
            check(g.available===true&&g.autoInstallPerformed===false&&/^\d+\.\d+\.\d+$/.test(g.version)&&g.version===manifest.engines?.pnpm&&manifest.packageManager==='pnpm@'+g.version,code);
            check(typeof g.cli==='string'&&(path.posix.isAbsolute(g.cli)||path.win32.isAbsolute(g.cli))&&digest.test(g.cliSha256)&&digest.test(g.packageManifestSha256),code);
            let metadata;try{metadata=JSON.parse(readLog('package-manager.json').toString('utf8'));}catch{throw Error(code);}
            check(metadata&&Object.keys(metadata).length===keys.length&&keys.every(key=>metadata[key]===g[key]),code);
          }
        }else check(typeof g.reason==='string'&&/^[A-Z][A-Z0-9_]+$/.test(g.reason),code);
        (g.status==='passed'?passed:failed).push(g.name);continue;
      }
      check(g.log===g.name+'.log'&&digest.test(g.logSha256)&&typeof readLog==='function','CI_LOG_REQUIRED');
      const log=readLog(g.log);check(Buffer.isBuffer(log)&&hash(log)===g.logSha256,'CI_LOG_HASH');
      if(g.status==='passed'){
        check(g.exitCode===0&&g.signal===null&&!g.reason,'CI_PROCESS_NOT_PASSED');
        if(TAP.has(g.name)){
          const p=processEvidence({status:0,signal:null},log.toString('utf8'),{requireTap:true});
          check(p.status==='passed'&&COUNT_KEYS.every(k=>g.counts?.[k]===p.counts[k]),'CI_TAP_INVALID');
        }
      }
      if(Object.hasOwn(FRAMEWORKS,g.name)&&(g.status==='passed'||g.frameworkReport!==undefined)){
        check(g.framework===FRAMEWORKS[g.name]&&g.frameworkReport===g.name+'.report.json'&&digest.test(g.frameworkReportSha256),'CI_FRAMEWORK_INVALID');
        let parsed;try{
          const bytes=readLog(g.frameworkReport);
          check(Buffer.isBuffer(bytes)&&hash(bytes)===g.frameworkReportSha256,'CI_FRAMEWORK_INVALID');
          parsed=frameworkEvidence(g.framework,JSON.parse(bytes.toString('utf8')));
        }catch{throw Error('CI_FRAMEWORK_INVALID');}
        check(g.status!=='passed'||parsed.status==='passed','CI_FRAMEWORK_INVALID');
        check(COUNT_KEYS.every(key=>parsed.counts?.[key]===g.counts?.[key]),'CI_FRAMEWORK_COUNTS');
      }
      if(g.counts!==undefined){
        check(TAP.has(g.name)||Object.hasOwn(FRAMEWORKS,g.name),'CI_UNEXPECTED_COUNTS');
        check(COUNT_KEYS.every(k=>Number.isSafeInteger(g.counts[k])&&g.counts[k]>=0),'CI_COUNTS_INVALID');
        for(const k of COUNT_KEYS){total[k]+=g.counts[k];check(Number.isSafeInteger(total[k]),'CI_COUNTS_OVERFLOW');}
      }
    }
    (g.status==='passed'?passed:failed).push(g.name);
  }
  check(COUNT_KEYS.every(k=>report.selectedTestCounts?.[k]===total[k]),'CI_TOTAL_COUNTS');
  const full=passed.length===ALL.length;
  check(report.fullLocalAcceptancePassed===full,'CI_FULL_FLAG_INCONSISTENT');
  // verify.mjs --full returns 2 for a complete but unaccepted report; 1/signals/timeouts are errors.
  check(execution&&execution.status===(full?0:2)&&!execution.signal&&!execution.error,'CI_VERIFIER_NOT_COMPLETED');
  const developmentChecksPassed=failed.length===0&&REQUIRED.every(x=>passed.includes(x));
  const runtimeChecksPassed=developmentChecksPassed&&RUNTIME_GATES.every(x=>passed.includes(x));
  return {schema:'realdex.development-ci.v1',profile,sourceDigest:expectedDigest,
    developmentChecksPassed,runtimeChecksPassed,fullLocalAcceptancePassed:full,productionReady:false,publicDeploymentPerformed:false,
    accepted:profile==='strict'?full:profile==='runtime'?runtimeChecksPassed:developmentChecksPassed,passed,failed,blocked,
    verifierExitCode:execution.status,acceptanceReportSha256:hash(JSON.stringify(report)),
    notice:'Development CI success is not full acceptance, canonical promotion, independent review or production approval.'};
}
function readEvidence(dir,name){
  const p=path.join(dir,name),s=fs.lstatSync(p);
  check(s.isFile()&&!s.isSymbolicLink()&&s.size<=33554432,'CI_EVIDENCE_FILE');return fs.readFileSync(p);
}
export function summaryMarkdown(r){
  return `## ${r.profile==='strict'?'Strict full acceptance':r.profile==='runtime'?'Provisioned runtime integration':'Development integration checks'}\n\n`+
    `Development checks: **${r.developmentChecksPassed?'passed':'failed'}**. Runtime checks: **${r.runtimeChecksPassed?'passed':'NOT PASSED'}**. Full acceptance: **${r.fullLocalAcceptancePassed?'passed':'NOT PASSED'}**. Production approval: **false**.\n\n`+
    `Passed gates: ${r.passed.length}; failed gates: ${r.failed.length}; explicitly deferred gates: ${r.blocked.length}.\n\n`+
    '| Deferred gate | Status | Reason |\n| --- | --- | --- |\n'+r.blocked.map(g=>`| ${g.name} | blocked | ${g.reason} |`).join('\n')+'\n\n'+r.notice+'\n';
}
export function runCiAcceptance(root,output,profile='strict',run=spawnSync){
  check(['development','runtime','strict'].includes(profile),'CI_PROFILE_INVALID');
  output=path.resolve(output);check(!fs.existsSync(output),'CI_OUTPUT_EXISTS');
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:30000}).trim();
  const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');git('diff','--exit-code','HEAD','--');
  const initial=sourceSnapshot(root,{exclude:[output]});
  const runnerLog=output+'.runner.log';fs.mkdirSync(path.dirname(output),{recursive:true});
  const fd=fs.openSync(runnerLog,'wx',0o600),start=Date.now();let result;
  try{result=run(process.execPath,['app/verify.mjs','--full','--output',output],{cwd:root,stdio:['ignore',fd,fd],timeout:2100000,shell:false});}
  finally{fs.closeSync(fd);}
  check(result&&!result.error&&!result.signal&&[0,2].includes(result.status),'CI_VERIFIER_NOT_COMPLETED');
  check(git('rev-parse','HEAD')===commit&&git('rev-parse','HEAD^{tree}')===tree,'CI_GIT_CHANGED');git('diff','--exit-code','HEAD','--');
  const report=JSON.parse(readEvidence(output,'acceptance.json'));
  const created=Date.parse(report.createdAt);check(Number.isFinite(created)&&created>=start-5000&&created<=Date.now()+5000,'CI_STALE_REPORT');
  const before=JSON.parse(readEvidence(output,'source-before.json')),after=JSON.parse(readEvidence(output,'source-after.json'));
  check(sourceSnapshot(root,{exclude:[output]}).digest===initial.digest,'CI_SOURCE_CHANGED');
  const verdict={...evaluateAcceptance(report,{profile,execution:result,expectedDigest:initial.digest,before,after,readLog:n=>readEvidence(output,n),readSource:n=>readEvidence(root,n)}),
    commit,tree,createdAt:new Date().toISOString(),runnerLogSha256:hash(fs.readFileSync(runnerLog))};
  fs.writeFileSync(path.join(output,'ci-profile.json'),JSON.stringify(verdict,null,2)+'\n',{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(output,'ci-summary.md'),summaryMarkdown(verdict),{flag:'wx',mode:0o600});
  return verdict;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const a=process.argv.slice(2);check(a.length===4&&a[0]==='--profile'&&a[2]==='--output','Usage: node dev/ci-acceptance.mjs --profile development|runtime|strict --output DIRECTORY');
    const r=runCiAcceptance(path.resolve(import.meta.dirname,'..'),a[3],a[1]);
    console.log(JSON.stringify(r,null,2));if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,summaryMarkdown(r));
    process.exitCode=r.accepted?0:2;
  }catch(e){console.error('CI evidence rejected:',e.message);process.exitCode=1;}
}
