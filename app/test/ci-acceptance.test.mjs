import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createHash} from 'node:crypto';import {execFileSync,spawnSync} from 'node:child_process';
import {REQUIRED,DEFERRED,RUNTIME_GATES,evaluateAcceptance,runCiAcceptance,summaryMarkdown} from '../../dev/ci-acceptance.mjs';
import {ROOT_SCRIPT_GATES,rootScriptPlan} from '../lib/root-script-plan.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const counts={tests:1,pass:1,fail:0,cancelled:0,skipped:0,todo:0};
const tap=Buffer.from('TAP version 13\n1..1\nok 1 - fixture\n'+Object.entries(counts).map(([k,v])=>`# ${k} ${v}`).join('\n')+'\n');
const COUNT_KEYS=['tests','pass','fail','cancelled','skipped','todo'];
const TAP_GATES=new Set(['wallet-tests','node-tests','external-spot-tests','app-tests','relay-tests','root-release-plan','native-real-evm','amm-pinned-real-evm','smart-account-stable-candidate-evm','stellar-core-runtime',...RUNTIME_GATES]);
// Kept as its own list rather than imported, so that a change to the evaluator's table
// has to be made deliberately in both places instead of agreeing with itself.
const FRAMEWORKS={ 'root-contract-tests':'mocha','root-ui-tests':'vitest','real-evm-wallet-integration':'mocha','public-testnet-readers':'vitest' };
const manifestFor=()=>({
  engines:{pnpm:'11.25.0'},packageManager:'pnpm@11.25.0',
  scripts:Object.fromEntries([
    ['build','fixture build'],
    ['test',ROOT_SCRIPT_GATES.filter(g=>g.script!=='build').map(g=>`npm run ${g.script}`).join(' && ')],
    ...ROOT_SCRIPT_GATES.filter(g=>g.script!=='build').map(g=>[g.script,`fixture ${g.script}`]),
  ]),
});
const mochaReport={stats:{tests:1,passes:1,failures:0,pending:0},tests:[{file:'fixture.test.mjs',fullTitle:'fixture passes',title:'passes',err:{}}],passes:[{file:'fixture.test.mjs',fullTitle:'fixture passes',title:'passes',err:{}}],failures:[],pending:[]};
const vitestReport={success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:[{status:'passed',assertionResults:[{fullName:'fixture passes',title:'passes',status:'passed'}]}]};
function totalCounts(gates){return Object.fromEntries(COUNT_KEYS.map(k=>[k,gates.reduce((sum,g)=>sum+(g.counts?.[k]??0),0)]));}
function refreshSource(f,manifest){
 const bytes=Buffer.from(JSON.stringify(manifest));f.packageBytes=bytes;
 const row=f.options.before.files.find(file=>file.path==='package.json');row.size=bytes.length;row.sha256=hash(bytes);
 f.options.before.digest=hash(JSON.stringify(f.options.before.files));f.options.after=structuredClone(f.options.before);
 f.r.sourceDigest=f.options.before.digest;f.options.expectedDigest=f.r.sourceDigest;
 for(const g of f.r.gates){if(g.sourceDigest!==undefined)g.sourceDigest=f.r.sourceDigest;if(g.name==='source-stability'){g.before=f.r.sourceDigest;g.after=f.r.sourceDigest;}}
 f.packageManager.packageManifestSha256=hash(bytes);f.r.gates.find(g=>g.name==='root-package-manager').packageManifestSha256=f.packageManager.packageManifestSha256;f.logs['package-manager.json']=Buffer.from(JSON.stringify(f.packageManager));
 f.options.readSource=name=>name==='package.json'?f.packageBytes:undefined;
}
function refreshTotals(f){f.r.selectedTestCounts=totalCounts(f.r.gates);}
function fixture(){
 const manifest=manifestFor(),packageBytes=Buffer.from(JSON.stringify(manifest));
 const files=[{path:'app/verify.mjs',size:0,sha256:hash('')},{path:'package.json',size:packageBytes.length,sha256:hash(packageBytes)}],d=hash(JSON.stringify(files));
 const snapshot={schema:'realdex.source-snapshot.v1',files,digest:d};const logs={};
 const packageManager={available:true,version:'11.25.0',cli:path.resolve(os.tmpdir(),'fixture-pnpm.cjs'),cliSha256:hash('fixture-pnpm-cli'),packageManifestSha256:hash(packageBytes),autoInstallPerformed:false};
 logs['package-manager.json']=Buffer.from(JSON.stringify(packageManager));
 const gate=name=>{
  if(name==='root-script-declarations')return {name,status:'passed',sourceDigest:d,scope:'package-json-declared-root-test-completeness',scripts:rootScriptPlan(manifest).map(g=>g.script)};
  if(name==='root-package-manager')return {name,status:'passed',sourceDigest:d,scope:'explicit-pinned-pnpm-version; no-auto-install',...packageManager};
  const reportFormat=FRAMEWORKS[name];
  if(reportFormat){const logBytes=Buffer.from(name),reportBytes=Buffer.from(JSON.stringify(reportFormat==='mocha'?mochaReport:vitestReport));logs[name+'.log']=logBytes;logs[name+'.report.json']=reportBytes;return {name,status:'passed',sourceDigest:d,exitCode:0,signal:null,counts:{...counts},log:name+'.log',logSha256:hash(logBytes),framework:reportFormat,frameworkReport:name+'.report.json',frameworkReportSha256:hash(reportBytes)};}
  if(name==='source-stability')return {name,status:'passed',before:d,after:d};
  if(name==='runtime-configuration')return {name,status:'passed',problems:[]};
  const hasCounts=TAP_GATES.has(name);const bytes=hasCounts?tap:Buffer.from(name);
  logs[name+'.log']=bytes;
  return {name,status:'passed',sourceDigest:d,exitCode:0,signal:null,...(hasCounts?{counts:{...counts}}:{}),log:name+'.log',logSha256:hash(bytes)};
 };
 const gates=REQUIRED.map(gate);
 gates.push(...Object.entries(DEFERRED).map(([name,reason])=>({name,status:'blocked',sourceDigest:d,reason})));
 const selected=totalCounts(gates);
 const r={schema:'realdex.acceptance.v2',fullRequested:true,solanaRequested:true,bitcoinRequested:true,cosmosRequested:true,aptosRequested:true,ibcRequested:true,
  sourceDigest:d,fullLocalAcceptancePassed:false,productionReady:false,publicDeploymentPerformed:false,gates,selectedTestCounts:selected};
 const options={profile:'development',expectedDigest:d,before:snapshot,after:structuredClone(snapshot),execution:{status:2,signal:null},readLog:n=>logs[n],readSource:n=>n==='package.json'?packageBytes:undefined};
 const f={r,options,logs,gate,evaluate:()=>evaluateAcceptance(r,options),manifest,packageBytes,packageManager};
 return f;
}
test('Development success keeps eleven deferred gates blocked and full/production false',()=>{
 const f=fixture(),original=JSON.stringify(f.r),v=f.evaluate();assert.equal(v.accepted,true);assert.equal(v.passed.length,REQUIRED.length);assert.equal(v.blocked.length,Object.keys(DEFERRED).length);
 assert.equal(v.fullLocalAcceptancePassed,false);assert.equal(v.productionReady,false);assert.equal(JSON.stringify(f.r),original);assert.match(summaryMarkdown(v),/NOT PASSED/);
});
test('Default and explicit strict profiles reject the same blocked report',()=>{const f=fixture();f.options.profile='strict';assert.equal(f.evaluate().accepted,false);delete f.options.profile;assert.equal(f.evaluate().accepted,false);});
test('All completed gates can pass strict while production remains false',()=>{
 const f=fixture();f.r.gates=f.r.gates.map(g=>g.status==='blocked'?f.gate(g.name):g);refreshTotals(f);
 f.r.fullLocalAcceptancePassed=true;f.options.execution.status=0;f.options.profile='strict';assert.equal(f.evaluate().accepted,true);assert.equal(f.evaluate().productionReady,false);
});
// The public reader check was moved out of root-ui-tests, where it could only ever
// report as pending, and given a gate of its own. That only stays honest while the gate
// is genuinely reported: if the verifier's blocked reason and the evaluator's table ever
// drift apart, a real run raises CI_UNEXPECTED_BLOCK — but only if someone runs it
// blocked. These read the two sources and compare them directly, so the drift fails here
// instead of waiting for the right kind of run.
test('The public reader gate is deferred with the reason the verifier actually emits',()=>{
 const code=fs.readFileSync(new URL('../verify.mjs',import.meta.url),'utf8');
 const reason=DEFERRED['public-testnet-readers'];
 assert.equal(reason,'PUBLIC_NETWORK_READS_NOT_ENABLED');
 assert.ok(code.includes(`blocked('public-testnet-readers','${reason}'`),'verify.mjs must block the gate with exactly that reason');
 assert.ok(code.includes("environment.REALDEX_PUBLIC_NETWORK_READS==='1'"),'the gate must run only on an explicit opt-in');
 assert.ok(code.includes("environment.REALDEX_LIVE='1'"),'the gate must set REALDEX_LIVE for the child, or the test it runs reports pending');
 assert.ok(code.includes("delete environment.REALDEX_LIVE"),'REALDEX_LIVE must not leak into any other gate');
 assert.ok(code.includes('vitest.live.config.ts'),'the gate must use the config that includes the excluded file');
});
test('The public reader gate is not a local runtime gate and is not read as TAP',()=>{
 assert.ok(Object.hasOwn(DEFERRED,'public-testnet-readers'));
 assert.ok(!RUNTIME_GATES.includes('public-testnet-readers'),'it depends on somebody else\'s endpoints, not on this machine');
 assert.ok(!TAP_GATES.has('public-testnet-readers'),'it reports as vitest JSON, not TAP');
});
// The exclusion in vitest.config.ts is only defensible because the excluded file is
// included somewhere else. If both lists ever name it, or neither does, the check runs
// nowhere and nothing else notices.
test('The file excluded from the offline suite is the file the live config includes',()=>{
 const offline=fs.readFileSync(new URL('../../vitest.config.ts',import.meta.url),'utf8');
 const live=fs.readFileSync(new URL('../../vitest.live.config.ts',import.meta.url),'utf8');
 const file='src/release/v01-public-verification.test.ts';
 assert.ok(offline.includes(`exclude: [...configDefaults.exclude, "${file}"]`),'the offline suite must exclude exactly that file, and keep vitest\'s own defaults');
 assert.ok(live.includes(`include: ["${file}"]`),'the live config must include exactly that file');
 // The key, not the word: the comment above it says "excluded" several times.
 assert.ok(!/^\s*exclude\s*:/m.test(live),'the live config must not exclude the only file it runs');
});
test('Source package bytes and their pinned snapshot hash must agree',()=>{
 const f=fixture();f.options.readSource=()=>Buffer.from(f.packageBytes+'changed');assert.throws(f.evaluate,/CI_SOURCE_MANIFEST/);
});
for(const [name,mutate] of Object.entries({
 'script omission':manifest=>{delete manifest.scripts['test:release-plan'];},
 'script duplicate':manifest=>{manifest.scripts.test+=' && npm run test:release-plan';},
 'script wrong order':manifest=>{const parts=manifest.scripts.test.split(' && ');[parts[0],parts[1]]=[parts[1],parts[0]];manifest.scripts.test=parts.join(' && ');},
}))test('Root declaration '+name+' is rejected',()=>{
 const f=fixture(),manifest=structuredClone(f.manifest);mutate(manifest);refreshSource(f,manifest);assert.throws(f.evaluate,/CI_ROOT_DECLARATIONS/);
});
test('Pinned package manager version, auto-install, and metadata cannot be altered',()=>{
 const version=fixture();version.r.gates.find(g=>g.name==='root-package-manager').version='12.0.0';assert.throws(version.evaluate,/CI_PACKAGE_MANAGER/);
 const install=fixture();install.r.gates.find(g=>g.name==='root-package-manager').autoInstallPerformed=true;assert.throws(install.evaluate,/CI_PACKAGE_MANAGER/);
 const metadata=fixture();metadata.logs['package-manager.json']=Buffer.from(JSON.stringify({...metadata.packageManager,cliSha256:hash('different')}));assert.throws(metadata.evaluate,/CI_PACKAGE_MANAGER/);
});
test('Framework reports require presence and matching hash',()=>{
 const missing=fixture(),missingGate=missing.r.gates.find(g=>g.name==='root-ui-tests');delete missing.logs[missingGate.frameworkReport];assert.throws(missing.evaluate,/CI_FRAMEWORK_INVALID/);
 const hashMismatch=fixture(),hashGate=hashMismatch.r.gates.find(g=>g.name==='root-contract-tests');hashGate.frameworkReportSha256='a'.repeat(64);assert.throws(hashMismatch.evaluate,/CI_FRAMEWORK_INVALID/);
});
test('Pending and contradictory framework counts are rejected',()=>{
 const pending=fixture(),pendingGate=pending.r.gates.find(g=>g.name==='root-ui-tests');const pendingReport={...vitestReport,numPassedTests:0,numPendingTests:1,testResults:[{status:'passed',assertionResults:[{fullName:'pending',title:'pending',status:'pending'}]}]};const pendingBytes=Buffer.from(JSON.stringify(pendingReport));pending.logs[pendingGate.frameworkReport]=pendingBytes;pendingGate.frameworkReportSha256=hash(pendingBytes);pendingGate.counts={...counts,pass:0,skipped:1};refreshTotals(pending);assert.throws(pending.evaluate,/CI_FRAMEWORK_INVALID/);
 const contradictory=fixture(),contradictoryGate=contradictory.r.gates.find(g=>g.name==='root-ui-tests');contradictoryGate.counts={...counts,pass:0};refreshTotals(contradictory);assert.throws(contradictory.evaluate,/CI_FRAMEWORK_COUNTS/);
});
test('The release-plan gate still requires valid TAP evidence',()=>{
 const f=fixture(),gate=f.r.gates.find(g=>g.name==='root-release-plan'),bytes=Buffer.from('node tests completed');f.logs[gate.log]=bytes;gate.logSha256=hash(bytes);assert.throws(f.evaluate,/CI_TAP_INVALID/);
});
for(const name of REQUIRED)test('Configured gate may not become deferred: '+name,()=>{const f=fixture();Object.assign(f.r.gates.find(g=>g.name===name),{status:'blocked',reason:'NOT_CONFIGURED'});assert.throws(f.evaluate);});
for(const name of Object.keys(DEFERRED)){
 test('Unknown defer reason is not exempt: '+name,()=>{const f=fixture();f.r.gates.find(g=>g.name===name).reason='TOOL_HASH_MISMATCH';assert.throws(f.evaluate,/UNEXPECTED_BLOCK/);});
 test('An executed failure in deferred runtime still fails: '+name,()=>{const f=fixture(),g=f.gate(name);g.status='failed';g.exitCode=1;f.r.gates[f.r.gates.findIndex(x=>x.name===name)]=g;refreshTotals(f);assert.equal(f.evaluate().accepted,false);});
}
for(const execution of [{status:1},{status:null},{status:0},{status:137},{status:2,signal:'SIGTERM'},{status:2,error:new Error('timeout')}])test('Reject incomplete verifier '+JSON.stringify(execution),()=>{const f=fixture();f.options.execution=execution;assert.throws(f.evaluate,/VERIFIER_NOT_COMPLETED/);});
for(const [name,mutate] of Object.entries({
 'missing gate':f=>f.r.gates.pop(),
 'duplicate gate':f=>f.r.gates[1]=structuredClone(f.r.gates[0]),
 'unknown gate':f=>f.r.gates[0].name='invented',
 'skipped':f=>f.r.gates[0].status='skipped',
 'not run':f=>f.r.gates[0].status='not-run',
 'stale source':f=>f.r.sourceDigest='f'.repeat(64),
 'gate from other source':f=>f.r.gates[0].sourceDigest='f'.repeat(64),
 'mutated snapshot':f=>f.options.before.files[0].size=1,
 'source changed':f=>f.r.gates.find(g=>g.name==='source-stability').after='a'.repeat(64),
 'runtime problem':f=>f.r.gates.find(g=>g.name==='runtime-configuration').problems.push('bad'),
 'report not full':f=>f.r.fullRequested=false,
 'missing scope':f=>delete f.r.ibcRequested,
 'fake full acceptance':f=>f.r.fullLocalAcceptancePassed=true,
 'fake production':f=>f.r.productionReady=true,
 'fake deployment':f=>f.r.publicDeploymentPerformed=true,
 'truncated log':f=>f.logs['wallet-tests.log']=Buffer.from('truncated'),
 'missing log':f=>delete f.logs['wallet-tests.log'],
 'path traversal':f=>f.r.gates[0].log='../secrets',
 'passing nonzero exit':f=>f.r.gates[0].exitCode=1,
 'passing signal':f=>f.r.gates[0].signal='SIGKILL',
 'invented build counts':f=>{f.r.gates.find(g=>g.name==='root-build').counts={...counts};refreshTotals(f);},
 'malformed counts':f=>f.r.gates[0].counts.tests='1',
 'inconsistent total':f=>f.r.selectedTestCounts.tests++,
 'executed blocked':f=>f.r.gates.find(g=>g.status==='blocked').exitCode=0,
 'bad profile':f=>f.options.profile='allow-all'
}))test('Evidence corruption is rejected: '+name,()=>{const f=fixture();mutate(f);assert.throws(f.evaluate);});
for(const text of ['success\n',tap.toString()+tap.toString(),tap.toString().replace('# pass 1','# pass 0')])test('Log checksum alone cannot make invalid TAP pass '+hash(text).slice(0,8),()=>{const f=fixture();f.logs['wallet-tests.log']=Buffer.from(text);f.r.gates[0].logSha256=hash(text);assert.throws(f.evaluate,/TAP_INVALID/);});
test('Actual known root-build failure remains a failed development run',()=>{const f=fixture();const g=f.r.gates.find(g=>g.name==='root-build');g.status='failed';g.exitCode=2;const v=f.evaluate();assert.equal(v.accepted,false);assert.deepEqual(v.failed,['root-build']);});
function repo(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-ci-fixture-'));t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
 fs.mkdirSync(path.join(root,'app'));fs.writeFileSync(path.join(root,'app/verify.mjs'),'// disposable fixture\n');
 const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'ignore'});git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-qm','fixture');
 return root;
}
for(const [name,code] of [['failure',1],['missing report',2]])test('Real child '+name+' cannot pass CI',t=>{
 const root=repo(t),output=path.join(root,'out');
 const run=(_cmd,_args,options)=>spawnSync(process.execPath,['-e',`process.exit(${code})`],options);
 assert.throws(()=>runCiAcceptance(root,output,'development',run));assert.equal(fs.existsSync(path.join(output,'ci-profile.json')),false);
});
test('Child timeout is rejected rather than deferred',t=>{const root=repo(t);assert.throws(()=>runCiAcceptance(root,path.join(root,'out'),'development',()=>({status:null,signal:'SIGTERM',error:new Error('timeout')})),/VERIFIER_NOT_COMPLETED/);});
test('Existing output is never reused as fresh successful evidence',t=>{const root=repo(t),output=path.join(root,'out');fs.mkdirSync(output);let called=false;assert.throws(()=>runCiAcceptance(root,output,'development',()=>{called=true;}),/OUTPUT_EXISTS/);assert.equal(called,false);});
test('CLI rejects unsupported modes before running the full verifier',()=>{const r=spawnSync(process.execPath,['dev/ci-acceptance.mjs','--profile','ignore','--output','not-created'],{cwd:path.resolve(import.meta.dirname,'../..'),encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/PROFILE_INVALID/);});

// A runtime-required profile is stronger than the historical development profile.
function provisionedFixture(){
 const f=fixture();f.options.profile='runtime';
 f.r.gates=f.r.gates.map(g=>RUNTIME_GATES.includes(g.name)?f.gate(g.name):g);
 refreshTotals(f);return f;
}
test('Runtime profile requires nine real-runtime gates and leaves only two non-runtime blockers',()=>{
 const f=provisionedFixture(),v=f.evaluate();assert.equal(v.accepted,true);assert.equal(v.runtimeChecksPassed,true);
 assert.equal(v.passed.length,REQUIRED.length+RUNTIME_GATES.length);assert.equal(v.blocked.length,Object.keys(DEFERRED).length-RUNTIME_GATES.length);assert.equal(v.fullLocalAcceptancePassed,false);
 f.options.profile='strict';assert.equal(f.evaluate().accepted,false);
});
for(const name of RUNTIME_GATES)test('Runtime profile rejects missing configured runtime '+name,()=>{
 const f=provisionedFixture();f.r.gates[f.r.gates.findIndex(g=>g.name===name)]={name,status:'blocked',sourceDigest:f.r.sourceDigest,reason:DEFERRED[name]};
 f.r.selectedTestCounts.tests--;f.r.selectedTestCounts.pass--;
 const v=f.evaluate();assert.equal(v.developmentChecksPassed,true);assert.equal(v.runtimeChecksPassed,false);assert.equal(v.accepted,false);
});
test('Unprovisioned historical report cannot pass runtime profile',()=>{const f=fixture();f.options.profile='runtime';assert.equal(f.evaluate().accepted,false);});
