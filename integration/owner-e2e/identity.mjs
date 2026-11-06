import {createHash} from 'node:crypto';
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {need,sha} from './protocol.mjs';
export function sourceIdentity(root,{expectedCommit,expectedTree}={}){
 need(/^[a-f0-9]{40}$/.test(expectedCommit??'')&&/^[a-f0-9]{40}$/.test(expectedTree??''),'E2E_FULL_PINS_REQUIRED');
 root=fs.realpathSync(root);const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:15000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']}).trim();
 need(git(['rev-parse','--show-toplevel'])===root,'E2E_SOURCE_ROOT');
 const commit=git(['rev-parse','HEAD']),tree=git(['rev-parse','HEAD^{tree}']);need(commit===expectedCommit&&tree===expectedTree,'E2E_SOURCE_PIN_MISMATCH');
 need(git(['status','--porcelain','--untracked-files=all'])==='','E2E_SOURCE_NOT_CLEAN');
 const entries=execFileSync('git',['ls-tree','-rz','HEAD'],{cwd:root,maxBuffer:4194304}).toString('utf8').split('\0').filter(Boolean),files=[];
 for(const entry of entries){const m=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);need(m,'E2E_SOURCE_ENTRY');const relative=m[3];need(!path.isAbsolute(relative)&&!relative.split('/').includes('..'),'E2E_SOURCE_PATH');const p=path.join(root,relative),s=fs.lstatSync(p);need(s.isFile()&&!s.isSymbolicLink(),'E2E_SOURCE_FILE');const b=fs.readFileSync(p);need(createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex')===m[2],'E2E_SOURCE_BLOB_MISMATCH');need(((s.mode&0o111)!==0)===(m[1]==='100755'),'E2E_SOURCE_MODE_MISMATCH');files.push({path:relative,bytes:b.length,mode:m[1],sha256:sha(b)});}
 files.sort((a,b)=>a.path<b.path?-1:1);return {commit,tree,files,digest:sha(JSON.stringify(files)),trackedFiles:files.length};
}
export function newOutput(root,directory){
 const p=path.resolve(directory),r=fs.realpathSync(root);need(p!==r&&!p.startsWith(r+path.sep),'E2E_OUTPUT_OUTSIDE_SOURCE');
 for(const ancestor of [p,...function*(){let a=path.dirname(p);for(;;){yield a;const b=path.dirname(a);if(b===a)break;a=b;}}()]){
  try{need(!fs.lstatSync(ancestor).isSymbolicLink(),'E2E_OUTPUT_SYMLINK');}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 need(!fs.existsSync(p)&&fs.statSync(path.dirname(p)).isDirectory(),'E2E_OUTPUT_EXISTS_OR_PARENT');fs.mkdirSync(p,{mode:0o700});return p;
}
