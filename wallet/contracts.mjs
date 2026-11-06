#!/usr/bin/env node
/** Local artifact tooling, no deployment or wallet access. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {need,safeError} from './lib/guard.mjs';
import {buildPoolIdentity,inspectPoolIdentity} from './lib/contract-identity.mjs';
import {Rpc,validateNetwork} from './lib/network.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function read(file,limit=32*1024*1024){const s=fs.lstatSync(file);need(s.isFile()&&!s.isSymbolicLink()&&s.size<=limit,'ARTIFACT_FILE_INVALID');return JSON.parse(fs.readFileSync(file,'utf8'));}
try{
  const [command,...args]=process.argv.slice(2);const options={};
  need(args.length%2===0,'ARGUMENT_INVALID');for(let i=0;i<args.length;i+=2){need(['--build-info','--output','--identity','--sha256','--network','--request'].includes(args[i])&&!Object.hasOwn(options,args[i]),'ARGUMENT_INVALID');options[args[i]]=args[i+1];}
  let result;
  if(command==='build-identity'){
    need(options['--build-info']&&options['--output']&&Object.keys(options).length===2,'ARGUMENT_INVALID');
    const info=read(options['--build-info']),sources={};
    for(const name of Object.keys(info.input?.sources??{})){
      need(/^contracts\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.sol$/.test(name),'SOURCE_PATH_NOT_ALLOWED');
      const file=path.resolve(root,name);need(fs.realpathSync(file).startsWith(root+path.sep),'SOURCE_PATH_NOT_ALLOWED');
      sources[name]=fs.readFileSync(file,'utf8');
    }
    result=buildPoolIdentity(info,{sources,expectedRuntimeHashes:read(path.join(root,'src/swap/local-amm-code-identities.json'))});
    fs.writeFileSync(options['--output'],JSON.stringify(result.identity,null,2)+'\n',{flag:'wx',mode:0o600});
    result={written:true,sha256:result.sha256,compilerReproducedHere:false};
  }else if(command==='inspect'){
    need(['--identity','--sha256','--network','--request'].every(k=>options[k])&&Object.keys(options).length===4,'ARGUMENT_INVALID');
    result=await inspectPoolIdentity(new Rpc(),validateNetwork(read(options['--network'],131072)),read(options['--identity'],524288),options['--sha256'],read(options['--request'],8192));
  }else throw Error('COMMAND_REQUIRED_BUILD_IDENTITY_OR_INSPECT');
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(safeError(error));process.exitCode=1;}
