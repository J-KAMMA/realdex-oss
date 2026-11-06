/** Local Git identity checks. These do not prove full acceptance or remote canonical status. */
import {execFileSync} from 'node:child_process';
export const OBJECT_ID=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export function git(root,args){return execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']}).trim();}
export function requireObjectId(value,code='GIT_OBJECT_ID_REQUIRED'){
 if(typeof value!=='string'||!OBJECT_ID.test(value))throw Error(code);return value;
}
export function workBranch(value){
 if(typeof value!=='string'||! /^(?:work|dev)\/[a-z][a-z0-9._/-]{0,110}$/.test(value)||value.includes('..')||value.includes('//')||value.split('/').some(x=>!x||x.startsWith('.')||x.endsWith('.')||x.endsWith('.lock')))throw Error('PUBLISH_WORK_BRANCH_REQUIRED');
 return value;
}
export function baseBranch(value){
 if(value==='main'||value==='import/latest-complete-source')return value;
 return workBranch(value);
}
export function resolveCommit(root,ref){
 if(typeof ref!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref)||ref.includes('..')||ref.includes('//'))throw Error('BASE_REF_INVALID');
 return requireObjectId(git(root,['rev-parse','--verify','--end-of-options',ref+'^{commit}']),'BASE_COMMIT_INVALID');
}
const SENTINELS=['RELEASE.json','package.json','app/ci.mjs','node/test/run-tests.mjs','wallet/test/run.mjs'];
export function inspectDevelopmentBase(root,ref,{expectedTree,requireCanonical=false}={}){
 const commit=resolveCommit(root,ref),tree=requireObjectId(git(root,['rev-parse',commit+'^{tree}']));
 if(expectedTree!==undefined&&tree!==requireObjectId(expectedTree,'BASE_TREE_ID_REQUIRED'))throw Error('BASE_TREE_MISMATCH');
 for(const name of SENTINELS){
  const entry=git(root,['ls-tree',commit,'--',name]);
  if(!new RegExp('^100(?:644|755) blob [a-f0-9]+\\t'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$').test(entry))throw Error('BASE_IMPLEMENTATION_MISSING');
 }
 let release;try{release=JSON.parse(git(root,['show',commit+':RELEASE.json']));}catch{throw Error('BASE_RELEASE_INVALID');}
 if(release?.schema!=='realdex.release-lineage.v1'||typeof release.version!=='string'||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(release.version)||typeof release.productionReady!=='boolean')throw Error('BASE_RELEASE_INVALID');
 if(requireCanonical){
  let current='';try{current=git(root,['show',commit+':CURRENT.md']);}catch{}
  const flags=current.match(/^canonical:\s*(?:true|false)\s*$/gm)??[];
  if(flags.length!==1||!/^canonical:\s*true\s*$/.test(flags[0]))throw Error('MAIN_NOT_CANONICAL_USE_PINNED_BASE');
 }
 return {commit,tree,release:release.version,layoutChecked:true,completeTreeVerified:false,productionApproval:false};
}
