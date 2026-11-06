#!/usr/bin/env node
/** Compile the delivered source bytes with a hash-pinned local binary. No RPC or deployment. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import pin from './compiler-pin.cjs';
import {need, safeError} from '../wallet/lib/guard.mjs';
import {keccak256} from '../node/verified/keccak.mjs';
import {buildPoolIdentity} from '../wallet/lib/contract-identity.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=b=>createHash('sha256').update(b).digest('hex');
export function compilerInput(root=ROOT){
  const sources={};
  const visit=directory=>{
    for(const entry of fs.readdirSync(path.join(root,directory)).sort()){
      const name=directory+'/'+entry,absolute=path.join(root,name),stat=fs.lstatSync(absolute);
      need(!stat.isSymbolicLink(),'SOLIDITY_SOURCE_SYMLINK');
      if(stat.isDirectory())visit(name);
      else if(name.endsWith('.sol')){need(stat.isFile()&&stat.size<1048576,'SOLIDITY_SOURCE_INVALID');sources[name]={content:fs.readFileSync(absolute,'utf8')};}
    }
  };
  visit('contracts');need(Object.keys(sources).length>0&&Object.keys(sources).length<=128,'SOLIDITY_SOURCE_COUNT');
  return {language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:500},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode','evm.deployedBytecode','metadata'],'':['ast']}}}};
}
export function compileLocal({compiler,output,root=ROOT}){
  const checked=pin.verifiedCompiler(compiler),input=compilerInput(root),inputText=JSON.stringify(input);
  const destination=path.resolve(output);need(!fs.existsSync(destination),'COMPILER_OUTPUT_ALREADY_EXISTS');fs.mkdirSync(destination,{recursive:true,mode:0o700});
  const result=spawnSync(checked.compilerPath,['--standard-json'],{input:inputText,encoding:'utf8',timeout:120000,maxBuffer:33554432,shell:false,
    env:{PATH:process.env.PATH??'',LANG:'C',LC_ALL:'C'}});
  need(result.status===0&&!result.error,'LOCAL_COMPILER_EXECUTION_FAILED');
  let compiled;try{compiled=JSON.parse(result.stdout);}catch{throw Error('COMPILER_OUTPUT_INVALID');}
  need(!compiled.errors?.some(e=>e.severity==='error'),'SOLIDITY_COMPILATION_FAILED');
  const factory=compiled.contracts?.['contracts/LocalSwapFactory.sol']?.LocalSwapFactory,
    router=compiled.contracts?.['contracts/LocalSwapRouter.sol']?.LocalSwapRouter;
  need(factory&&router,'COMPILED_CONTRACT_MISSING');
  const info={solcVersion:pin.PIN.version,solcLongVersion:pin.PIN.longVersion,input,output:compiled};
  const identity=buildPoolIdentity(info,{sources:Object.fromEntries(Object.entries(input.sources).map(([k,v])=>[k,v.content])),
    expectedRuntimeHashes:{factoryRuntimeCodeHash:keccak256('0x'+factory.evm.deployedBytecode.object),routerRuntimeCodeHash:keccak256('0x'+router.evm.deployedBytecode.object)}});
  const files={'standard-input.json':input,'build-info.json':info,'pool-identity.json':identity};
  for(const [name,value]of Object.entries(files))fs.writeFileSync(path.join(destination,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  const report={schema:'realdex.local-compilation.v1',compilerSha256:pin.PIN.sha256,compiler:pin.PIN.longVersion,
    inputSha256:digest(inputText),sourceHashes:Object.fromEntries(Object.entries(input.sources).map(([k,v])=>[k,digest(v.content)])),
    files:Object.fromEntries(Object.keys(files).map(name=>[name,digest(fs.readFileSync(path.join(destination,name)))])),
    compilerExecuted:true,solidityCompiled:true,evmExecutionPerformed:false,chainDeploymentPerformed:false,
    compilerIdentityIsNotIndependentAudit:true,productionReady:false};
  fs.writeFileSync(path.join(destination,'compilation.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);need(args.length===4&&args[0]==='--compiler'&&args[2]==='--output','COMPILE_ARGUMENTS_INVALID');
    console.log(JSON.stringify(compileLocal({compiler:args[1],output:args[3]}),null,2));
  }catch(e){console.error(safeError(e));process.exitCode=2;}
}
