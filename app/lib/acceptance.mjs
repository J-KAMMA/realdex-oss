/** Evidence aggregation never promotes empty, skipped, blocked, or changing-source runs. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {need} from '../../wallet/lib/guard.mjs';
import {ROOT_SCRIPT_GATES} from './root-script-plan.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const ACCOUNT_RUNTIME_GATES=Object.freeze(['stellar-core-runtime','aptos-local-runtime']);
export const ROOT_GATES=Object.freeze(['root-script-declarations','root-package-manager',
  ...ROOT_SCRIPT_GATES.map(gate=>gate.name),'real-evm-wallet-integration']);
export function processEvidence(result,text,{requireTap=false}={}){
  // A missing counter is unknown, not zero. Reject duplicated/concatenated summaries.
  const keys=['tests','pass','fail','cancelled','skipped','todo'];
  const rows=Object.fromEntries(keys.map(k=>[k,[...text.matchAll(new RegExp('^# '+k+' ([0-9]+)\\r?$','gm'))].map(m=>Number(m[1]))]));
  const complete=keys.every(k=>rows[k].length===1&&Number.isSafeInteger(rows[k][0])&&rows[k][0]>=0);
  const counts=Object.fromEntries(keys.map(k=>[k,rows[k].length===1&&Number.isSafeInteger(rows[k][0])?rows[k][0]:0]));
  const processPassed=result.status===0&&!result.error&&!result.signal;
  const nonempty=complete&&counts.tests>0&&counts.pass===counts.tests&&counts.fail===0&&counts.cancelled===0&&counts.skipped===0&&counts.todo===0;
  return {status:processPassed&&(!requireTap||nonempty)?'passed':'failed',exitCode:result.status??null,signal:result.signal??null,
    ...(requireTap?{counts}:{}),...(result.error?{reason:'PROCESS_NOT_COMPLETED'}:requireTap&&!nonempty?{reason:'TAP_NOT_ALL_TESTS_EXECUTED_AND_PASSED'}:{})};
}
export function acceptancePassed(gates,required){
  return required.length>0&&new Set(required).size===required.length&&required.every(name=>{
    const found=gates.filter(g=>g.name===name);return found.length===1&&found[0].status==='passed';
  })&&gates.every(g=>g.status==='passed');
}
const SOURCE_ROOTS=['dev','relay','plans','app','contracts','integration','node','src','scripts','test','tests','wallet','public','.github'];
const ROOT_FILES=['AGENTS.md','CONTRIBUTING.md','.gitignore','.gitattributes','RELEASE.json','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.node-version','.env.example','hardhat.config.cjs',
  'hardhat.v01-test.config.cjs','tsconfig.json','tsconfig.app.json','tsconfig.node.json','vite.config.ts','vitest.config.ts','index.html','experimental.html',
  'start-realdex.sh','start-realdex.cmd','start-wallet.sh','start-wallet.cmd','integration/browser-requirements.txt'];
const SKIP=new Set(['node_modules','.git','dist','docs','evidence','.cache','.artifacts','__pycache__']);
const SOURCE_EXTENSION=/\.(mjs|cjs|js|mts|cts|ts|tsx|jsx|py|sol|json|html|css|yaml|yml|toml|svg|sh|ps1)$/;
export function sourceSnapshot(root,{exclude=[]}={}){
  root=path.resolve(root);const excluded=exclude.map(p=>path.resolve(p));const files=[];
  const visit=(relative,force=false)=>{
    const absolute=path.join(root,relative);
    if(excluded.some(p=>absolute===p||absolute.startsWith(p+path.sep)))return;
    let s;try{s=fs.lstatSync(absolute);}catch(e){if(e.code==='ENOENT')return;throw e;}
    need(!s.isSymbolicLink(),'SOURCE_SYMLINK_FORBIDDEN');
    if(s.isDirectory()){
      for(const name of fs.readdirSync(absolute).sort())if(!SKIP.has(name)&&!name.startsWith('.tmp'))visit(relative+'/'+name);
    }else if(force||SOURCE_EXTENSION.test(relative)){
      need(s.isFile()&&s.size<=33554432&&!/[\r\n]/.test(relative),'SOURCE_FILE_INVALID');
      files.push({path:relative,size:s.size,sha256:hash(fs.readFileSync(absolute))});
    }
  };
  for(const name of SOURCE_ROOTS)visit(name);
  for(const name of ROOT_FILES)visit(name,true);
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  need(files.length>0,'SOURCE_SNAPSHOT_EMPTY');
  return {schema:'realdex.source-snapshot.v1',files,digest:hash(JSON.stringify(files)),
    scope:'executable sources, test sources, static text assets, explicit toolchain manifests; excludes historical evidence, docs, build outputs, dependency installs and private wallet data'};
}
