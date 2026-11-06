#!/usr/bin/env node
/** Conservative pattern scan of all blobs reachable from the branch to publish.
 * Findings never include matched secret values. This is not a security audit.
 */
import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
function run(root,args,input){const r=spawnSync('git',args,{cwd:root,input,encoding:null,maxBuffer:134217728,shell:false});if(r.status!==0)throw Error('GIT_INSPECTION_FAILED');return r.stdout;}
export function inspectFile(name,bytes){
 const rules=[];
 if(/(?:^|\/)(?:\.env(?:\..*)?|\.cookie|vault\.json|wallet\.enc|writer\.lock)$/.test(name)&&!/(?:\.example|\.sample|\.template)$/.test(name))rules.push('PRIVATE_STATE_PATH');
 if(/(?:^|\/)(?:\.realdex(?:[-\w]*)?|node_modules|evidence|logs)(?:\/|$)/.test(name))rules.push('PRIVATE_OR_GENERATED_DIRECTORY');
 if(/\.(?:key|pem|p12|pfx|enc|sqlite3?|db|bundle|zip)$/.test(name))rules.push('SENSITIVE_OR_BINARY_ARCHIVE_PATH');
 const text=bytes.toString('utf8');
 if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))rules.push('PRIVATE_KEY_MATERIAL');
 if(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/.test(text))rules.push('GITHUB_CREDENTIAL');
 if(/#key=[A-Fa-f0-9]{48,}/.test(text))rules.push('OWNER_CAPABILITY_URL');
 return rules.map(rule=>({path:name,rule}));
}
export function scanHistory(root,ref='main'){
 if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref)||ref.includes('..'))throw Error('SCAN_REF_INVALID');
 const revision=run(root,['rev-parse','--verify','--end-of-options',ref+'^{commit}']).toString('utf8').trim();
 const rows=run(root,['rev-list','--objects',revision]).toString('utf8').trim().split('\n').filter(Boolean).map(line=>{const i=line.indexOf(' ');return {sha:i<0?line:line.slice(0,i),path:i<0?'':line.slice(i+1)};});
 const types=run(root,['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],rows.map(x=>x.sha).join('\n')+'\n').toString('utf8').trim().split('\n');
 const blobs=rows.filter((x,i)=>types[i].split(' ')[1]==='blob');let bytesExpected=0;
 for(const line of types){const [hash,type,size]=line.split(' ');if(type==='blob'){if(!/^\d+$/.test(size)||Number(size)>16777216)throw Error('SOURCE_BLOB_TOO_LARGE');bytesExpected+=Number(size);}}
 if(bytesExpected>100663296)throw Error('SOURCE_HISTORY_TOO_LARGE');
 // Walk every committed tree as well: one blob may have both a harmless path
 // and a sensitive path in different commits. rev-list --objects lists it once.
 const pathFindings=[];const seenPaths=new Set();
 for(const commit of run(root,['rev-list',revision]).toString('utf8').trim().split('\n')){
  const entries=run(root,['ls-tree','-r','-z','--full-tree',commit]).toString('utf8').split('\0').filter(Boolean);
  for(const entry of entries){const tab=entry.indexOf('\t'),meta=entry.slice(0,tab).split(' '),name=entry.slice(tab+1);
   if(meta[0]==='120000'||meta[0]==='160000')pathFindings.push({path:name,rule:'SYMLINK_OR_SUBMODULE'});
   if(!seenPaths.has(name)){pathFindings.push(...inspectFile(name,Buffer.alloc(0)));seenPaths.add(name);}
  }
 }
 const data=blobs.length?run(root,['cat-file','--batch'],blobs.map(x=>x.sha).join('\n')+'\n'):Buffer.alloc(0);let offset=0;const findings=[...pathFindings];
 for(const blob of blobs){const nl=data.indexOf(10,offset);if(nl<0)throw Error('GIT_BATCH_TRUNCATED');const header=data.subarray(offset,nl).toString('utf8').split(' ');
  if(header[0]!==blob.sha||header[1]!=='blob'||!/^\d+$/.test(header[2]))throw Error('GIT_BATCH_INVALID');const size=Number(header[2]);offset=nl+1;
  if(offset+size>=data.length)throw Error('GIT_BATCH_TRUNCATED');findings.push(...inspectFile(blob.path,data.subarray(offset,offset+size)));offset+=size+1;
 }
 return {schema:'realdex.source-hygiene.v1',revision,blobsScanned:blobs.length,pathsScanned:seenPaths.size,bytesScanned:bytesExpected,passed:findings.length===0,findings,heuristicOnly:true,independentSecurityReview:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const r=scanHistory(root,process.argv[2]??'main');console.log(JSON.stringify(r,null,2));process.exitCode=r.passed?0:1;
}catch(e){console.error(e.message);process.exitCode=1;}
