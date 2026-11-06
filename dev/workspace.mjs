#!/usr/bin/env node
/** Local Git worktrees only. No agent spawning, reset, force push or implicit merge. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {git,inspectDevelopmentBase,requireObjectId} from './git-state.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const WORKSTREAMS=JSON.parse(fs.readFileSync(path.join(ROOT,'dev/workstreams.json'),'utf8'));
export function validateWorkstreams(value=WORKSTREAMS){
 if(value?.schema!=='realdex.workstreams.v1'||value.baseBranch!=='main'||!Array.isArray(value.lanes)||!value.lanes.length)throw Error('WORKSTREAMS_INVALID');
 const ids=new Set(),branches=new Set();for(const x of value.lanes){
  if(!/^[a-z][a-z0-9-]{0,30}$/.test(x.id)||ids.has(x.id)||!/^work\/[a-z][a-z0-9-]{0,30}$/.test(x.branch)||branches.has(x.branch))throw Error('WORKSTREAM_DUPLICATE_OR_INVALID');
  if(!Array.isArray(x.paths)||!x.paths.length||x.paths.some(p=>typeof p!=='string'||p.startsWith('/')||p.includes('..')||p.includes('\\')||/[\x00-\x1f]/.test(p)))throw Error('WORKSTREAM_PATH_INVALID');
  ids.add(x.id);branches.add(x.branch);
 }return true;
}
export function checkScope(changed,laneId,config=WORKSTREAMS){
 validateWorkstreams(config);const lane=config.lanes.find(x=>x.id===laneId);if(!lane)throw Error('UNKNOWN_WORKSTREAM');
 const outside=changed.filter(p=>!lane.paths.some(allowed=>p===allowed||(allowed.endsWith('/')||allowed.endsWith('-')||allowed.endsWith('/ibc'))&&p.startsWith(allowed)));
 return {lane:laneId,changed,outside,passed:outside.length===0};
}
export function createWorktree(root,laneId,{base,expectedTree}={}){
 validateWorkstreams();const lane=WORKSTREAMS.lanes.find(x=>x.id===laneId);if(!lane)throw Error('UNKNOWN_WORKSTREAM');
 root=fs.realpathSync(root);
 if(git(root,['rev-parse','--show-toplevel'])!==root)throw Error('WORKTREE_ROOT_REQUIRED');
 if(git(root,['status','--porcelain','--untracked-files=all']))throw Error('WORKTREE_REQUIRES_CLEAN_SOURCE');
 const explicit=base!==undefined;
 if(explicit){requireObjectId(base,'PINNED_BASE_COMMIT_REQUIRED');requireObjectId(expectedTree,'PINNED_BASE_TREE_REQUIRED');}
 else if(expectedTree!==undefined)throw Error('PINNED_BASE_COMMIT_REQUIRED');
 const identity=inspectDevelopmentBase(root,explicit?base:'refs/heads/'+WORKSTREAMS.baseBranch,{expectedTree,requireCanonical:!explicit});
 const parent=path.join(root,'.worktrees'),target=path.join(parent,laneId);
 const exists=p=>{try{return fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
 const parentStat=exists(parent);
 if(parentStat&&(!parentStat.isDirectory()||parentStat.isSymbolicLink()||fs.realpathSync(parent)!==parent))throw Error('WORKTREE_PARENT_UNSAFE');
 if(exists(target))throw Error('WORKTREE_PATH_EXISTS');
 if(git(root,['for-each-ref','--format=%(refname)','refs/heads/'+lane.branch]).split('\n').includes('refs/heads/'+lane.branch))throw Error('WORKTREE_BRANCH_EXISTS');
 fs.mkdirSync(parent,{recursive:true});
 // The resolved object is immutable: never pass a moving main/branch name here.
 git(root,['worktree','add','-b',lane.branch,target,identity.commit]);
 if(git(target,['rev-parse','HEAD'])!==identity.commit||git(target,['rev-parse','HEAD^{tree}'])!==identity.tree)throw Error('WORKTREE_CREATED_IDENTITY_MISMATCH');
 return {path:target,branch:lane.branch,base:identity.commit,baseTree:identity.tree,baseSelection:explicit?'explicit-pinned':'local-main',canonicalApproval:false,remoteStatus:'not-inspected'};
}
function main(){
 const args=process.argv.slice(2);validateWorkstreams();
 if(args.length===1&&args[0]==='validate'){console.log(JSON.stringify({valid:true,lanes:WORKSTREAMS.lanes.map(x=>x.id),remoteStatus:'not-inspected-by-this-command'}));return;}
 if(args.length===1&&args[0]==='status'){console.log(git(ROOT,['worktree','list']));return;}
 if(args[0]==='create'&&(args.length===2||(args.length===6&&args[2]==='--base'&&args[4]==='--expect-tree'))){console.log(JSON.stringify(createWorktree(ROOT,args[1],args.length===6?{base:args[3],expectedTree:args[5]}:{}),null,2));return;}
 if(args.length===3&&args[0]==='check'){
  if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(args[2])||args[2].includes('..'))throw Error('BASE_REF_INVALID');
  const base=git(ROOT,['rev-parse','--verify','--end-of-options',args[2]+'^{commit}']);
  const changed=git(ROOT,['diff','--name-only','-z',base+'...HEAD','--']).split('\0').filter(Boolean),result=checkScope(changed,args[1]);
  console.log(JSON.stringify(result,null,2));process.exitCode=result.passed?0:1;return;
 }
 throw Error('Usage: node dev/workspace.mjs validate | status | create LANE [--base COMMIT --expect-tree TREE] | check LANE BASE_REF');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{main();}catch(e){console.error(e.message);process.exitCode=1;}
