#!/usr/bin/env node
/** Reproducible auxiliary build. This does not satisfy the stable-compiler release gate. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {compileProbe} from '../amm/compiler.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
export function compileSmart({compiler=process.env.REALDEX_EXPERIMENTAL_SOLJSON,profile='experimental'}={}) {
  const build=compileProbe({profile,compiler,root:ROOT});
  const contracts={};
  for(const name of ['RealDexSmartAccount','RealDexSmartAccountFactory']) {
    const source=`contracts/smart/${name}.sol`,c=build.output.contracts[source][name],ast=build.output.sources[source].ast;
    const declarations=ast.nodes.find(n=>n.nodeType==='ContractDefinition'&&n.name===name).nodes;
    const immutableNames=Object.fromEntries(declarations.filter(n=>n.nodeType==='VariableDeclaration'&&n.mutability==='immutable').map(n=>[n.id,n.name]));
    contracts[name]={source,abi:c.abi,creationCode:'0x'+c.evm.bytecode.object,runtimeTemplate:'0x'+c.evm.deployedBytecode.object,
      immutableReferences:Object.fromEntries(Object.entries(c.evm.deployedBytecode.immutableReferences??{}).map(([id,v])=>[immutableNames[id],v]))};
  }
  const artifact={schema:'realdex.smart-account-build.v1',compiler:build.evidence.compilerVersion,compilerSha256:build.evidence.compilerSha256,
    experimentalOnly:build.evidence.experimentalOnly,productionApproved:false,settings:build.input.settings,
    sources:Object.fromEntries(Object.entries(build.evidence.sourceHashes).filter(([p])=>p.startsWith('contracts/smart/'))),contracts};
  return {build,artifact};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const destination=process.argv[2];if(!destination)throw Error('OUTPUT_REQUIRED');
  const {artifact}=compileSmart();fs.writeFileSync(destination,JSON.stringify(artifact,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({file:destination,sha256:sha(fs.readFileSync(destination)),compiler:artifact.compiler,experimentalOnly:artifact.experimentalOnly}));
}
