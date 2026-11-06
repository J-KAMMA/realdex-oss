/** One exact-source acceptance of the existing local owner scenarios. No release approval. */
import fs from 'node:fs';import path from 'node:path';
import {runProcess,testEnvironment} from '../../app/lib/parallel-process.mjs';
import {processEvidence} from '../../app/lib/acceptance.mjs';
import {parseExactJson} from '../../node/extended/json.mjs';
import {sourceIdentity,newOutput} from './identity.mjs';import {requireReferenceSource} from './reference-guard.mjs';
import {need,sha,verifyEvidence} from './protocol.mjs';
import {verifyCrashEvidence} from './crash-protocol.mjs';import {verifyFailureEvidence} from './failure-protocol.mjs';import {verifyConcurrencyEvidence} from './concurrency-protocol.mjs';
import {verifyAuthorityEvidence} from './authority-protocol.mjs';
const ROOT=path.resolve(import.meta.dirname,'../..');
export const RUNTIME_TESTS=Object.freeze(['Lifecycle','OwnerActions','OwnerContinuity','OwnerDeposit','OwnerRecovery','OwnerSubmissionExpiry','OwnerWallet'].map(n=>'integration/injective/'+n+'.test.mjs'));
const SCENARIOS=Object.freeze([
 Object.freeze({id:'roundtrip',script:'run.mjs',checker:'check-evidence.py',mode:'api',checks:20,validate:verifyEvidence}),
 Object.freeze({id:'crash',script:'run-crash.mjs',checker:'check-crash-evidence.py',checks:32,validate:verifyCrashEvidence}),
 Object.freeze({id:'included-failure',script:'run-failure.mjs',checker:'check-failure-evidence.py',checks:44,validate:verifyFailureEvidence}),
 Object.freeze({id:'concurrency',script:'run-concurrency.mjs',checker:'check-concurrency-evidence.py',checks:55,validate:verifyConcurrencyEvidence}),
 Object.freeze({id:'authority',script:'run-authority.mjs',checker:'check-authority-evidence.py',checks:60,validate:verifyAuthorityEvidence}),
 Object.freeze({id:'browser',script:'run.mjs',checker:'check-evidence.py',mode:'browser',checks:20,validate:verifyEvidence})
]);
export const GATE_IDS=Object.freeze(['injective-runtime',...SCENARIOS.map(s=>s.id)]);
const FALSE_FLAGS=Object.freeze(['productionReady','publicNetwork','stateProofVerified','checkpointCompatibilityVerified','productSuccessor','wholeProductAcceptance']);
const MAX_FILE=8388608;
export function strictJson(buffer){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
 parseExactJson(text,{maxChars:MAX_FILE,maxNodes:100000,maxDepth:40});return JSON.parse(text);
}
function regular(p,max=MAX_FILE){
 const st=fs.lstatSync(p);need(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=max,'E2E_ACCEPTANCE_FILE');
 const b=fs.readFileSync(p);need(b.length===st.size,'E2E_ACCEPTANCE_FILE_CHANGED');return b;
}
export function validateScenarioDirectory(directory,id,identity,execution){
 const spec=SCENARIOS.find(x=>x.id===id);need(spec,'E2E_ACCEPTANCE_GATE');
 need(execution?.status===0&&!execution.signal&&!execution.error,'E2E_ACCEPTANCE_PROCESS');
 need(!fs.lstatSync(directory).isSymbolicLink(),'E2E_ACCEPTANCE_DIRECTORY');
 const names=['source-before.json','source-after.json','result.json','steps.ndjson'];
 need(JSON.stringify(fs.readdirSync(directory).sort())===JSON.stringify([...names,'FILES.json'].sort()),'E2E_ACCEPTANCE_FILE_SET');
 const manifest=strictJson(regular(path.join(directory,'FILES.json'))),seen=new Set();
 need(Array.isArray(manifest)&&manifest.length===names.length,'E2E_ACCEPTANCE_MANIFEST');
 for(const m of manifest){need(m&&Object.keys(m).sort().join(',')==='path,sha256'&&names.includes(m.path)&&!seen.has(m.path)&&/^[a-f0-9]{64}$/.test(m.sha256),'E2E_ACCEPTANCE_MANIFEST');seen.add(m.path);need(sha(regular(path.join(directory,m.path)))===m.sha256,'E2E_ACCEPTANCE_HASH');}
 const before=strictJson(regular(path.join(directory,'source-before.json'))),after=strictJson(regular(path.join(directory,'source-after.json')));
 need(JSON.stringify(before)===JSON.stringify(identity)&&JSON.stringify(after)===JSON.stringify(identity),'E2E_ACCEPTANCE_SOURCE');
 const raw=regular(path.join(directory,'result.json')),result=strictJson(raw);
 need(result.sourceStable===true&&result.sourceDigest===identity.digest&&result.trackedFiles===identity.trackedFiles,'E2E_ACCEPTANCE_SOURCE');
 const at=Date.parse(result.createdAt),start=Date.parse(execution.startedAt),end=Date.parse(execution.finishedAt);
 need(Number.isFinite(at)&&Number.isFinite(start)&&Number.isFinite(end)&&at>=start-1000&&at<=end+1000,'E2E_ACCEPTANCE_STALE_REPORT');
 need(result.wholeProductAcceptance===false&&result.nodeVersion===process.versions.node,'E2E_ACCEPTANCE_SCOPE');
 spec.validate(result,{expectedCommit:identity.commit,expectedTree:identity.tree,...(spec.mode?{expectedMode:spec.mode}:{})});
 return {result,resultSha256:sha(raw),manifestSha256:sha(regular(path.join(directory,'FILES.json'))),scenarioChecks:spec.checks};
}
export function decideOwnerAcceptance(profile,gates,{sourceStable,runtimeStable}={}){
 need(['api','browser'].includes(profile)&&Array.isArray(gates)&&gates.length===GATE_IDS.length,'E2E_ACCEPTANCE_GATE_SET');
 need(new Set(gates.map(g=>g.id)).size===GATE_IDS.length&&GATE_IDS.every((id,i)=>gates[i]?.id===id),'E2E_ACCEPTANCE_GATE_SET');
 need(gates.every(g=>['passed','failed','blocked','not-run'].includes(g.status)),'E2E_ACCEPTANCE_GATE_STATUS');
 need(profile==='api'?gates.at(-1).status==='not-run':gates.at(-1).status!=='not-run','E2E_ACCEPTANCE_BROWSER_SCOPE');
 const apiPassed=sourceStable===true&&runtimeStable===true&&gates.slice(0,-1).every(g=>g.status==='passed');
 const browserPassed=apiPassed&&gates.at(-1).status==='passed';
 return {apiPassed,browserEndToEndPassed:browserPassed,requestedScopePassed:profile==='api'?apiPassed:browserPassed,...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false]))};
}
export function verifyRuntime(directory){
 need(process.platform==='linux'&&process.arch==='x64','E2E_ACCEPTANCE_PLATFORM');
 need(typeof directory==='string'&&path.isAbsolute(directory)&&fs.realpathSync(directory)===directory,'E2E_ACCEPTANCE_RUNTIME_PATH');
 const pin=strictJson(regular(path.join(ROOT,'integration/injective/pin.json'))),files=[];
 for(const [name,p] of Object.entries(pin.files)){
  const b=regular(path.join(directory,name),p.bytes);
  need(b.length===p.bytes&&sha(b)===p.sha256,'E2E_ACCEPTANCE_RUNTIME_HASH');files.push({name,bytes:b.length,sha256:sha(b)});
 }
 return {schema:'realdex.owner-runtime-identity.v1',version:pin.version,sourceCommit:pin.sourceCommit,files,independentlyRebuilt:false};
}
function resultFile(output,name,value){fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
function code(e){return e instanceof Error&&/^E2E_[A-Z0-9_]{1,80}$/.test(e.message)?e.message:'E2E_ACCEPTANCE_EXECUTION_FAILED';}
/** Production entry has no injectable commands, filters, skipped required cases or retries. */
export async function runOwnerAcceptance(options){
 need(['api','browser'].includes(options.profile),'E2E_ACCEPTANCE_PROFILE');
 const identity=sourceIdentity(ROOT,options),reference=requireReferenceSource(ROOT);
 const found=fs.readdirSync(path.join(ROOT,'integration/injective')).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'integration/injective/'+n);
 need(JSON.stringify(found)===JSON.stringify(RUNTIME_TESTS),'E2E_ACCEPTANCE_TEST_SET_CHANGED');
 const runtime=path.resolve(options.runtime),runtimeBefore=verifyRuntime(runtime),output=newOutput(ROOT,options.output);
 resultFile(output,'source-before.json',identity);resultFile(output,'runtime-before.json',runtimeBefore);
 const env={...testEnvironment(),REALDEX_INJECTIVE_DIRECTORY:runtime};const gates=[];
 const execute=async(args,name,timeoutMs=600000,command=process.execPath)=>{
  const log=path.join(output,name+'.log'),execution=await runProcess({command,args,cwd:ROOT,log,timeoutMs,env});
  return {execution,log:name+'.log',logSha256:sha(regular(log,33554432))};
 };
 const pins=['--expect-commit',identity.commit,'--expect-tree',identity.tree];
 for(const id of GATE_IDS){
  if(id==='browser'&&options.profile==='api'){gates.push({id,status:'not-run',reason:'E2E_BROWSER_NOT_REQUESTED'});continue;}
  let g={id,status:'failed'};
  try{
   need(sourceIdentity(ROOT,options).digest===identity.digest,'E2E_ACCEPTANCE_SOURCE_CHANGED');
   if(id==='injective-runtime'){
    const r=await execute(['--test','--test-concurrency=1','--test-reporter=tap',...RUNTIME_TESTS],id);
    const evaluation=processEvidence(r.execution,regular(path.join(output,r.log),33554432).toString('utf8'),{requireTap:true});
    g={...g,...r,status:evaluation.status,counts:evaluation.counts,testFiles:[...RUNTIME_TESTS],...(evaluation.reason?{reason:evaluation.reason}:{})};
   }else{
    const spec=SCENARIOS.find(s=>s.id===id),dir=path.join(output,id);
    const r=await execute(['integration/owner-e2e/'+spec.script,...(spec.mode?['--mode',spec.mode]:[]),'--runtime-dir',runtime,'--output',dir,...pins],id,360000);
    g={...g,...r};
    // A policy error stays a failure/blocked prerequisite; it is never replaced by API success.
    const checked=validateScenarioDirectory(dir,id,identity,r.execution);
    const args=['-I','integration/owner-e2e/'+spec.checker,...(spec.mode?[path.join(dir,'result.json')]:['--directory',dir,...pins])];
    const independent=await execute(args,id+'-independent',30000,'python3');g.independent=independent;
    need(independent.execution.status===0&&!independent.execution.signal&&!independent.execution.error,'E2E_ACCEPTANCE_INDEPENDENT_FAILED');
    const verdict=strictJson(regular(path.join(output,independent.log)));
    need(verdict.passed===true,'E2E_ACCEPTANCE_INDEPENDENT_FAILED');
    // Reject changes during the independent checker as well.
    validateScenarioDirectory(dir,id,identity,r.execution);
    g={...g,status:'passed',resultSha256:checked.resultSha256,manifestSha256:checked.manifestSha256,scenarioChecks:checked.scenarioChecks};
   }
  }catch(e){g.status='failed';g.reason=code(e);}
  gates.push(g);resultFile(output,id+'-gate.json',g);
  console.log(JSON.stringify({gate:id,status:g.status,reason:g.reason??null}));
 }
 let sourceStable=false,runtimeStable=false;const errors=[];
 try{const after=sourceIdentity(ROOT,options);sourceStable=after.digest===identity.digest;resultFile(output,'source-after.json',after);}catch(e){errors.push(code(e));}
 try{const after=verifyRuntime(runtime);runtimeStable=JSON.stringify(after)===JSON.stringify(runtimeBefore);resultFile(output,'runtime-after.json',after);}catch(e){errors.push(code(e));}
 const verdict={schema:'realdex.owner-acceptance.v1',profile:options.profile,commit:identity.commit,tree:identity.tree,sourceDigest:identity.digest,trackedFiles:identity.trackedFiles,
  reference,runtime:runtimeBefore,gates,sourceStable,runtimeStable,errors,...decideOwnerAcceptance(options.profile,gates,{sourceStable,runtimeStable}),
  tapCounts:gates[0].counts??null,scenarioChecks:gates.filter(g=>g.status==='passed'&&g.scenarioChecks).reduce((n,g)=>n+g.scenarioChecks,0),
  nodeVersion:process.versions.node,createdAt:new Date().toISOString(),notice:'Separate local API diagnostic gate. No browser claim in api mode, INJ13 compatibility, public execution, audit, or full product acceptance.'};
 resultFile(output,'owner-acceptance.json',verdict);return verdict;
}
