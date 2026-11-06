import {projectMetadata} from './lib/project-metadata.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import pin from '../integration/compiler-pin.cjs';
import {anvilStatus} from '../integration/anvil/toolchain.mjs';
import {aptosStatus} from '../integration/aptos/toolchain.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function doctor(){
  const project=projectMetadata(ROOT);
  const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
  const dependencies=Object.entries({...manifest.dependencies,...manifest.devDependencies}).map(([name,wanted])=>{
    try{const installed=JSON.parse(fs.readFileSync(path.join(ROOT,'node_modules',name,'package.json'),'utf8'));return {name,wanted,installedVersion:installed.version,available:installed.version===wanted};}catch{return {name,wanted,installedVersion:null,available:false};}
  });
  const version=process.versions.node.split('.').map(Number),nodeLocalSupported=version[0]>22||version[0]===22&&version[1]>=16;
  return {schema:'realdex.doctor.v1',release:project.release,packageVersion:project.packageVersion,runtimeConfigurationConsistent:project.configurationConsistent,runtimeConfigurationProblems:project.problems,nodeVersion:process.versions.node,localRuntimeSupported:nodeLocalSupported,
    rootRequiredNode:manifest.engines.node,rootNodeVersionMatches:process.versions.node===manifest.engines.node,
    localCompiler:pin.compilerStatus(process.env.REALDEX_SOLC_BINARY),localAnvil:anvilStatus(process.env.REALDEX_ANVIL_BINARY),localAptos:aptosStatus(process.env.REALDEX_APTOS_BINARY),dependencies,rootDependenciesResolvable:dependencies.every(x=>x.available),
    scope:{localWalletAndDiscovery:'available-with-node-no-npm-install',fullReactAndEvm:'requires-root-dependencies-and-compiler',
      liveNetworkTested:false,independentAudit:false,productionReady:false},
    secretsRead:false,networksContacted:false,transactionsSubmitted:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(doctor(),null,2));
