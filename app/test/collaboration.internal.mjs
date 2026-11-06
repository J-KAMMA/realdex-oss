import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {validateWorkstreams,checkScope,createWorktree,WORKSTREAMS} from '../../dev/workspace.mjs';
import {scanHistory,inspectFile} from '../../dev/source-hygiene.mjs';
import {publicationPlan,publish,parseRemoteTip} from '../../dev/github-publish.mjs';
import {inspectDevelopmentBase,workBranch} from '../../dev/git-state.mjs';
function fixture(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-git-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));const g=args=>execFileSync('git',args,{cwd:p,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 g(['init','--initial-branch=main']);g(['config','user.name','Test fixture']);g(['config','user.email','fixture@example.invalid']);fs.writeFileSync(path.join(p,'README.md'),'local fixture\n');fs.writeFileSync(path.join(p,'.gitignore'),'.worktrees/\n');for(const name of ['app/ci.mjs','node/test/run-tests.mjs','wallet/test/run.mjs']){fs.mkdirSync(path.dirname(path.join(p,name)),{recursive:true});fs.writeFileSync(path.join(p,name),'// layout fixture only\n');}fs.writeFileSync(path.join(p,'package.json'),'{}\n');fs.writeFileSync(path.join(p,'RELEASE.json'),JSON.stringify({schema:'realdex.release-lineage.v1',version:'0.26.0-dev.20260906',productionReady:false}));fs.writeFileSync(path.join(p,'CURRENT.md'),'status: fixture\ncanonical: true\n');g(['add','.']);g(['commit','-m','baseline']);return {p,g};}
test('All workstreams have distinct names and valid bounded path scopes',()=>assert.equal(validateWorkstreams(),true));
test('Foreign files are rejected by the workstream scope check',()=>{assert.equal(checkScope(['node/external/injective-orders.mjs'],'injective').passed,true);assert.equal(checkScope(['wallet/lib/vault.mjs'],'injective').passed,false);assert.throws(()=>checkScope([], '../main'));});
test('Duplicate workstream branches are rejected',()=>{const c=structuredClone(WORKSTREAMS);c.lanes[1].branch=c.lanes[0].branch;assert.throws(()=>validateWorkstreams(c));});
test('Worktree creation retains main and does not overwrite an existing branch or directory',t=>{
 const {p,g}=fixture(t),head=g(['rev-parse','main']),a=createWorktree(p,'injective');assert.equal(a.base,head);assert.equal(g(['rev-parse','main']),head);assert.ok(fs.existsSync(path.join(a.path,'.git')));assert.throws(()=>createWorktree(p,'injective'),/EXISTS/);
});
test('Dirty source is not silently stashed, reset or copied to a worktree',t=>{const {p}=fixture(t);fs.appendFileSync(path.join(p,'README.md'),'unsaved');assert.throws(()=>createWorktree(p,'runtime'),/CLEAN/);});
test('Local Git bundle retains commits and can be cloned without internet',t=>{
 const {p,g}=fixture(t),bundle=path.join(p,'../',path.basename(p)+'.bundle'),clone=path.join(p,'../',path.basename(p)+'-clone');t.after(()=>{fs.rmSync(bundle,{force:true});fs.rmSync(clone,{recursive:true,force:true});});
 g(['bundle','create',bundle,'--all']);execFileSync('git',['clone',bundle,clone],{stdio:'ignore'});assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:clone,encoding:'utf8'}).trim(),g(['rev-parse','HEAD']));
});
for(const name of ['.env','.env.production','.cookie','.realdex-wallet/vault.json','wallet/evidence/raw.log','private.pem'])test('Source scanner rejects sensitive path '+name,()=>assert.ok(inspectFile(name,Buffer.from('fixture')).length));
test('Source scanner returns only path and rule, never the credential',()=>{const value='ghp_'+'A'.repeat(36),result=inspectFile('example.txt',Buffer.from(value));assert.equal(result[0].rule,'GITHUB_CREDENTIAL');assert.ok(!JSON.stringify(result).includes(value));});
test('Ignored template is allowed but a literal credential is still detected in it',()=>{assert.deepEqual(inspectFile('.env.example',Buffer.from('KEY=replace-me')),[]);assert.ok(inspectFile('.env.example',Buffer.from('ghp_'+'A'.repeat(36))).length);});
test('A secret deleted in the latest tree is detected in publish history',t=>{const {p,g}=fixture(t);fs.writeFileSync(path.join(p,'accidental.txt'),'ghp_'+'A'.repeat(36));g(['add','.']);g(['commit','-m','bad fixture']);fs.unlinkSync(path.join(p,'accidental.txt'));g(['add','-u']);g(['commit','-m','delete fixture']);const r=scanHistory(p);assert.equal(r.passed,false);assert.ok(r.findings.some(x=>x.rule==='GITHUB_CREDENTIAL'));});
test('A clean commit scans without using working-directory credentials',t=>{const {p}=fixture(t);assert.equal(scanHistory(p).passed,true);});
test('Publication is a dry run unless apply is explicit',()=>{let called=false;const r=publish('/not-a-repo','J-KAMMA/RealDEX',{run:()=>{called=true;throw Error();}});assert.equal(r.status,'dry-run');assert.equal(called,false);assert.equal(r.visibility,'private');});
for(const repo of ['someone/RealDEX','J-KAMMA/Other','../RealDEX','J-KAMMA/RealDEX;rm'])test('Publication will not silently select a different repository '+repo,()=>assert.throws(()=>publicationPlan(repo)));
test('Identical content under a historical private path is still detected',t=>{
 const {p,g}=fixture(t);const same=fs.readFileSync(path.join(p,'README.md'));
 fs.writeFileSync(path.join(p,'.env'),same);g(['add','.env']);g(['commit','-m','historical path fixture']);fs.unlinkSync(path.join(p,'.env'));g(['add','-u']);g(['commit','-m','remove']);
 assert.ok(scanHistory(p).findings.some(x=>x.path==='.env'&&x.rule==='PRIVATE_STATE_PATH'));
});
test('Publishing history with a symlink cannot pass the source scan',t=>{const {p,g}=fixture(t);fs.symlinkSync('README.md',path.join(p,'link'));g(['add','.']);g(['commit','-m','symlink fixture']);assert.ok(scanHistory(p).findings.some(x=>x.rule==='SYMLINK_OR_SUBMODULE'));});

function fakeRemote(t,options={}){
 const {p,g}=fixture(t),base=g(['rev-parse','HEAD']),branch='work/platform-fixture';g(['checkout','-b',branch]);
 fs.writeFileSync(path.join(p,'change.txt'),'new work\n');g(['add','.']);g(['commit','-m','work']);const head=g(['rev-parse','HEAD']),calls=[];let pushed=false,views=0;
 const metadata={nameWithOwner:'J-KAMMA/RealDex',isPrivate:true,viewerPermission:'ADMIN',...options.metadata};
 const run=(cmd,args)=>{
  calls.push({cmd,args});const custom=options.intercept?.({cmd,args,p,g,head,base,pushed,views,calls});if(custom!==undefined)return custom;
  if(cmd==='gh'){
   if(args[0]==='api')return {status:0,stdout:options.owner??'J-KAMMA'};
   if(args[0]==='repo'&&args[1]==='view'){views++;return {status:options.unavailable?1:0,stdout:options.brokenJson??JSON.stringify(metadata)};}
   throw Error('UNEXPECTED_GH_WRITE');
  }
  if(args[0]==='config')return {status:1,stdout:''};
  if(args[0]==='ls-remote'){
   const ref=args.at(-1);let hash=ref==='refs/heads/'+branch?(pushed?(options.postPushMismatch?'f'.repeat(40):head):(options.remoteTip??'')):base;
   if(ref==='refs/heads/main'&&pushed&&options.mainAfterPush)hash=options.mainAfterPush;
   return {status:0,stdout:hash?hash+'\t'+ref:''};
  }
  if(args[0]==='push'){pushed=true;return {status:options.pushFails?1:0,stdout:''};}
  try{return {status:0,stdout:g(args)};}catch{return {status:1,stdout:''};}
 };
 return {p,g,run,calls,head,base,branch,apply:()=>publish(p,'J-KAMMA/RealDEX',{apply:true,run,branch,expectedHead:head,expectedBase:base})};
}
const noPush=f=>assert.equal(f.calls.some(x=>x.cmd==='git'&&x.args[0]==='push'),false);
test('Publisher only pushes a pinned work commit and reports PR/CI/canonical as incomplete',t=>{
 const f=fakeRemote(t),r=f.apply();assert.equal(r.commit,f.head);assert.equal(r.status,'branch-pushed');assert.equal(r.baseCommit,f.base);assert.equal(r.mainCommit,f.base);
 for(const k of ['created','remoteCreated','mergePerformed','agentsStarted','canonical','productionReady'])assert.equal(r[k],false);
 assert.equal(r.ciStatus,'not-observed');assert.equal(r.prStatus,'not-created');
 const push=f.calls.find(x=>x.args[0]==='push');assert.deepEqual(push.args,['push','--porcelain','--no-follow-tags','--recurse-submodules=no','https://github.com/J-KAMMA/RealDex.git',f.head+':refs/heads/'+f.branch]);
 assert.equal(f.g(['rev-parse','main']),f.base);assert.ok(!f.calls.some(x=>x.args.includes('create')||x.args.includes('--force')));
});
for(const branch of ['main','master','import/latest-complete-source','evidence/old','resume/foo','refs/heads/main','work/../main','work/x.lock','work/.hidden','work/x//y','work/x/','work/-bad','work/x\nmain','work/foo@{1}'])test('Publisher rejects protected/invalid destination '+JSON.stringify(branch),()=>{
 let called=false;assert.throws(()=>publish('/not-a-repo','J-KAMMA/RealDex',{apply:true,branch,expectedHead:'a'.repeat(40),expectedBase:'b'.repeat(40),run:()=>{called=true;}}),/WORK_BRANCH/);assert.equal(called,false);
});
for(const branch of ['work/platform','work/a-b.c_d/next','dev/issue-14'])test('Work branch syntax accepts '+branch,()=>assert.equal(workBranch(branch),branch));
test('Publisher requires explicit head and base pins before any external operation',()=>{
 for(const omitted of ['branch','expectedHead','expectedBase']){let called=false;const options={apply:true,branch:'work/test',expectedHead:'a'.repeat(40),expectedBase:'b'.repeat(40),run:()=>{called=true;}};delete options[omitted];assert.throws(()=>publish('/not-a-repo','J-KAMMA/RealDex',options));assert.equal(called,false);}
});
test('Publisher cannot use its target as the PR base',()=>assert.throws(()=>publicationPlan('J-KAMMA/RealDex',{branch:'work/test',baseBranch:'work/test'}),/BASE_EQUALS_HEAD/));
test('Publisher refuses a different authenticated owner before any write',t=>{const f=fakeRemote(t,{owner:'someone-else'});assert.throws(f.apply,/OWNER_MISMATCH/);noPush(f);});
test('Publisher refuses public repository without changing visibility',t=>{const f=fakeRemote(t,{metadata:{isPrivate:false}});assert.throws(f.apply,/MUST_BE_PRIVATE/);noPush(f);});
test('Publisher refuses unexpected repository identity',t=>{const f=fakeRemote(t,{metadata:{nameWithOwner:'other/RealDex'}});assert.throws(f.apply,/MUST_BE_PRIVATE/);noPush(f);});
test('Unavailable repository is not interpreted as authorization to create one',t=>{const f=fakeRemote(t,{unavailable:true});assert.throws(f.apply,/EXISTING_REPOSITORY_UNAVAILABLE/);noPush(f);assert.ok(!f.calls.some(x=>x.args.includes('create')));});
for(const brokenJson of ['{bad','null','[]','{}'])test('Malformed repository metadata fails closed '+brokenJson,t=>{const f=fakeRemote(t,{brokenJson});assert.throws(f.apply,/METADATA_INVALID/);noPush(f);});
for(const permission of ['READ','TRIAGE',null])test('Insufficient write permission rejects '+permission,t=>{const f=fakeRemote(t,{metadata:{viewerPermission:permission}});assert.throws(f.apply,/WRITE_PERMISSION/);noPush(f);});
test('A divergent remote work branch is never overwritten',t=>{const f=fakeRemote(t,{remoteTip:'f'.repeat(40)});assert.throws(f.apply,/DIVERGED/);noPush(f);});
test('An existing remote ancestor allows a non-force work-branch push',t=>{const f=fakeRemote(t);const original=f.run;const run=(cmd,args)=>cmd==='git'&&args[0]==='ls-remote'&&args.at(-1)==='refs/heads/'+f.branch&&!f.calls.some(c=>c.args[0]==='push')?{status:0,stdout:f.base+'\trefs/heads/'+f.branch}:original(cmd,args);const r=publish(f.p,'J-KAMMA/RealDex',{apply:true,branch:f.branch,expectedHead:f.head,expectedBase:f.base,run});assert.equal(r.commit,f.head);});
test('Wrong remote base pin is rejected before push',t=>{const f=fakeRemote(t,{intercept:({cmd,args})=>cmd==='git'&&args[0]==='ls-remote'&&args.at(-1)==='refs/heads/main'?{status:0,stdout:'e'.repeat(40)+'\trefs/heads/main'}:undefined});assert.throws(f.apply,/BASE_REVISION_MISMATCH/);noPush(f);});
test('A remote read timeout cannot become a successful empty remote',t=>{const f=fakeRemote(t,{intercept:({cmd,args})=>cmd==='git'&&args[0]==='ls-remote'?{status:null,stdout:''}:undefined});assert.throws(f.apply,/REMOTE_READ_FAILED/);noPush(f);});
test('Local URL rewrite rules require review instead of changing the push destination',t=>{const f=fakeRemote(t,{intercept:({cmd,args})=>cmd==='git'&&args[0]==='config'?{status:0,stdout:'url.ssh://other/.pushinsteadof https://github.com/'}:undefined});assert.throws(f.apply,/URL_REWRITE/);noPush(f);});
test('Config inspection failure cannot be treated as no rewrites',t=>{const f=fakeRemote(t,{intercept:({cmd,args})=>cmd==='git'&&args[0]==='config'?{status:128,stdout:''}:undefined});assert.throws(f.apply,/CONFIG_INSPECTION/);noPush(f);});
test('Source changed after scan is refused before push',t=>{const f=fakeRemote(t,{intercept:({cmd,args,p})=>{if(cmd==='gh'&&args[0]==='repo')fs.writeFileSync(path.join(p,'concurrent.txt'),'dirty');}});assert.throws(f.apply,/CLEAN_TREE/);noPush(f);});
test('Current local branch must equal the explicit work branch',t=>{const f=fakeRemote(t);f.g(['checkout','--detach',f.head]);assert.throws(f.apply,/BRANCH_MISMATCH/);noPush(f);});
test('Publish rejects a local head pin mismatch',t=>{const f=fakeRemote(t);assert.throws(()=>publish(f.p,'J-KAMMA/RealDex',{apply:true,branch:f.branch,expectedHead:f.base,expectedBase:f.base,run:f.run}),/SOURCE_CHANGED/);noPush(f);});
test('An unrelated PR base is rejected before external reads',t=>{const f=fakeRemote(t);assert.throws(()=>publish(f.p,'J-KAMMA/RealDex',{apply:true,branch:f.branch,expectedHead:f.head,expectedBase:'f'.repeat(40),run:f.run}),/BASE_NOT_ANCESTOR/);noPush(f);});
test('The pushed commit must be read back exactly',t=>{const f=fakeRemote(t,{postPushMismatch:true});assert.throws(f.apply,/REMOTE_REVISION_MISMATCH/);});
test('Failure of the push command is not a publication success',t=>{const f=fakeRemote(t,{pushFails:true});assert.throws(f.apply,/PUSH_FAILED/);});
test('Concurrent main changes after a work push are reported, not falsely called unchanged',t=>{const f=fakeRemote(t,{mainAfterPush:'e'.repeat(40)});assert.throws(f.apply,/BASE_CHANGED_AFTER_PUSH/);});
for(const [name,value] of [['duplicate','a'.repeat(40)+'\trefs/heads/main\n'+'a'.repeat(40)+'\trefs/heads/main'],['wrong ref','a'.repeat(40)+'\trefs/heads/other'],['garbage','success'],['missing tab','a'.repeat(40)+' refs/heads/main']])test('Remote ref parser rejects '+name,()=>assert.throws(()=>parseRemoteTip(value,'refs/heads/main'),/RESPONSE_INVALID/));
test('Missing main is not treated as an empty target work branch',()=>{assert.equal(parseRemoteTip('','refs/heads/work/test'),'');assert.throws(()=>parseRemoteTip('','refs/heads/main',{required:true}),/BRANCH_MISSING/);});

test('Bootstrap main cannot silently become a new development worktree',t=>{
 const {p,g}=fixture(t);fs.unlinkSync(path.join(p,'RELEASE.json'));g(['add','-u']);g(['commit','-m','bootstrap fixture']);
 assert.throws(()=>createWorktree(p,'runtime'),/IMPLEMENTATION_MISSING/);assert.equal(fs.existsSync(path.join(p,'.worktrees')),false);assert.equal(g(['branch','--list','work/runtime']),'');
});
test('Source-bearing but noncanonical main requires an explicit pinned base',t=>{
 const {p,g}=fixture(t);fs.writeFileSync(path.join(p,'CURRENT.md'),'canonical: false\n');g(['add','.']);g(['commit','-m','not canonical']);const base=g(['rev-parse','HEAD']),tree=g(['rev-parse','HEAD^{tree}']);
 assert.throws(()=>createWorktree(p,'runtime'),/MAIN_NOT_CANONICAL/);const r=createWorktree(p,'runtime',{base,expectedTree:tree});assert.equal(r.base,base);assert.equal(r.baseTree,tree);assert.equal(r.canonicalApproval,false);assert.equal(r.remoteStatus,'not-inspected');
});
test('Pinned continuation uses imported source while main remains bootstrap',t=>{
 const {p,g}=fixture(t),base=g(['rev-parse','HEAD']),tree=g(['rev-parse','HEAD^{tree}']);g(['checkout','-b','dev/imported']);g(['branch','-f','main',base]);
 // Make main a distinct bootstrap commit, then return to the imported commit.
 g(['checkout','main']);fs.unlinkSync(path.join(p,'RELEASE.json'));g(['add','-u']);g(['commit','-m','bootstrap']);const main=g(['rev-parse','main']);g(['checkout','dev/imported']);
 const r=createWorktree(p,'runtime',{base,expectedTree:tree});assert.equal(r.base,base);assert.ok(fs.existsSync(path.join(r.path,'RELEASE.json')));assert.equal(g(['rev-parse','main']),main);
});
test('Wrong tree pin fails before creating a branch or worktree',t=>{const {p,g}=fixture(t);assert.throws(()=>createWorktree(p,'runtime',{base:g(['rev-parse','HEAD']),expectedTree:'f'.repeat(40)}),/TREE_MISMATCH/);assert.equal(g(['branch','--list','work/runtime']),'');assert.equal(fs.existsSync(path.join(p,'.worktrees')),false);});
test('Moving refs and incomplete explicit pins cannot be used for continuation',t=>{const {p,g}=fixture(t);for(const options of [{base:'main',expectedTree:g(['rev-parse','HEAD^{tree}'])},{base:g(['rev-parse','HEAD'])},{expectedTree:g(['rev-parse','HEAD^{tree}'])}])assert.throws(()=>createWorktree(p,'runtime',options),/PINNED_BASE/);});
test('Malformed release metadata is not an implementation base',t=>{const {p,g}=fixture(t);fs.writeFileSync(path.join(p,'RELEASE.json'),'{}');g(['add','.']);g(['commit','-m','invalid']);assert.throws(()=>inspectDevelopmentBase(p,'HEAD'),/RELEASE_INVALID/);});
test('Missing implementation sentinel is rejected even with canonical:true',t=>{const {p,g}=fixture(t);fs.unlinkSync(path.join(p,'app/ci.mjs'));g(['add','-u']);g(['commit','-m','missing']);assert.throws(()=>createWorktree(p,'runtime'),/IMPLEMENTATION_MISSING/);});
test('Symlink implementation sentinels are not read as trusted source',t=>{const {p,g}=fixture(t);fs.unlinkSync(path.join(p,'RELEASE.json'));fs.symlinkSync('package.json',path.join(p,'RELEASE.json'));g(['add','.']);g(['commit','-m','symlink']);assert.throws(()=>createWorktree(p,'runtime'),/IMPLEMENTATION_MISSING/);});
test('A symlink worktree parent cannot redirect creation outside the repository',t=>{const {p}=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));fs.appendFileSync(path.join(p,'.git/info/exclude'),'\n/.worktrees\n');fs.symlinkSync(outside,path.join(p,'.worktrees'));assert.throws(()=>createWorktree(p,'runtime'),/PARENT_UNSAFE/);assert.deepEqual(fs.readdirSync(outside),[]);});
test('An existing branch without a worktree is not reset or reused',t=>{const {p,g}=fixture(t);g(['branch','work/runtime']);assert.throws(()=>createWorktree(p,'runtime'),/BRANCH_EXISTS/);assert.equal(fs.existsSync(path.join(p,'.worktrees')),false);});
for(const current of ['', 'canonical: true\ncanonical: false\n','canonical: false\n'])test('Absent or ambiguous canonical marker blocks implicit main '+JSON.stringify(current),t=>{const {p,g}=fixture(t);fs.writeFileSync(path.join(p,'CURRENT.md'),current);g(['add','.']);g(['commit','-m','marker']);assert.throws(()=>createWorktree(p,'runtime'),/MAIN_NOT_CANONICAL/);});
test('Git identity validation does not claim full-tree correctness or release approval',t=>{const {p}=fixture(t),r=inspectDevelopmentBase(p,'main');assert.equal(r.layoutChecked,true);assert.equal(r.completeTreeVerified,false);assert.equal(r.productionApproval,false);});

function bareRemote(t,{stacked=false}={}){
 const {p,g}=fixture(t),main=g(['rev-parse','HEAD']),branch='work/local-push-test',baseBranch=stacked?'work/previous-task':'main';
 if(stacked){g(['checkout','-b',baseBranch]);fs.writeFileSync(path.join(p,'previous.txt'),'previous task\n');g(['add','.']);g(['commit','-m','previous']);}
 const base=g(['rev-parse','HEAD']),bare=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-bare-'));t.after(()=>fs.rmSync(bare,{recursive:true,force:true}));
 execFileSync('git',['init','--bare',bare],{stdio:'ignore'});g(['push',bare,'refs/heads/main']);if(stacked)g(['push',bare,'refs/heads/'+baseBranch]);
 g(['checkout','-b',branch]);fs.writeFileSync(path.join(p,'work.txt'),'new work\n');g(['add','.']);g(['commit','-m','work']);const head=g(['rev-parse','HEAD']);
 const calls=[];const run=(cmd,args)=>{
  calls.push({cmd,args});if(cmd==='gh')return {status:0,stdout:args[0]==='api'?'J-KAMMA':JSON.stringify({nameWithOwner:'J-KAMMA/RealDex',isPrivate:true,viewerPermission:'WRITE'})};
  // The transport alone is redirected to a disposable bare Git repository. No network, token or asset key.
  const translated=args.map(x=>x==='https://github.com/J-KAMMA/RealDex.git'?bare:x);
  try{return {status:0,stdout:g(translated)};}catch(e){return {status:typeof e.status==='number'?e.status:1,stdout:e.stdout??''};}
 };
 return {p,g,bare,main,head,base,branch,baseBranch,calls,run,apply:()=>publish(p,'J-KAMMA/RealDex',{apply:true,branch,baseBranch,expectedHead:head,expectedBase:base,run})};
}
for(const stacked of [false,true])test('Real bare Git transport publishes only a pinned work branch; stacked='+stacked,t=>{
 const f=bareRemote(t,{stacked});f.g(['config','push.followTags','true']);f.g(['tag','-a','must-stay-local','-m','not for publication']);
 const r=f.apply();assert.equal(r.commit,f.head);assert.equal(r.baseBranch,f.baseBranch);
 assert.equal(f.g(['ls-remote','--heads',f.bare,'refs/heads/'+f.branch]),f.head+'\trefs/heads/'+f.branch);
 assert.equal(f.g(['ls-remote','--heads',f.bare,'refs/heads/main']),f.main+'\trefs/heads/main');
 assert.equal(f.g(['ls-remote','--heads',f.bare,'refs/heads/'+f.baseBranch]),f.base+'\trefs/heads/'+f.baseBranch);
 assert.equal(f.g(['ls-remote','--tags',f.bare]),'');
 assert.equal(f.apply().commit,f.head); // already-present exact commit remains idempotent
});
test('Real bare Git transport refuses a divergent existing work branch',t=>{
 const f=bareRemote(t);f.g(['checkout','--detach',f.base]);fs.writeFileSync(path.join(f.p,'other.txt'),'other author\n');f.g(['add','.']);f.g(['commit','-m','other']);const other=f.g(['rev-parse','HEAD']);
 f.g(['push',f.bare,other+':refs/heads/'+f.branch]);f.g(['checkout',f.branch]);
 assert.throws(f.apply,/DIVERGED/);noPush(f);assert.equal(f.g(['ls-remote','--heads',f.bare,'refs/heads/'+f.branch]),other+'\trefs/heads/'+f.branch);
});
test('Real URL rewrite configuration fails before publication',t=>{
 const f=bareRemote(t);f.g(['config','url.https://elsewhere.invalid/.pushInsteadOf','https://github.com/']);
 assert.throws(f.apply,/URL_REWRITE/);noPush(f);
});
test('Actual source CLI refuses obsolete --apply usage before authentication or network',()=>{
 const root=path.resolve(import.meta.dirname,'../..');let error;
 try{execFileSync(process.execPath,['dev/github-publish.mjs','--repo','J-KAMMA/RealDex','--apply'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});}catch(e){error=e;}
 assert.equal(error?.status,1);assert.match(error.stderr,/PUBLISH_WORK_BRANCH_REQUIRED/);
});
