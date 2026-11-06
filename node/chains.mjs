#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {makeRegistry,capabilities,importEvmCatalogue,customEvmProfile} from './chains/registry.mjs';
import {observeChain,observeMany} from './chains/observation.mjs';
import {CONTRACTS,makeCompilerInput,planEvmDeployment,inspectCompilerOutput} from './chains/deployment.mjs';
import {check,safeError} from './chains/core.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const help=`RealDEX multi-chain tools (read-only; no key or transaction methods)
  node node/chains.mjs list [--registry candidates.json]
  node node/chains.mjs inspect --chain eip155:1
  node node/chains.mjs probe --input request.json
  node node/chains.mjs probe-many --input jobs.json
  node node/chains.mjs import-evm --input chains.json --output candidates.json
  node node/chains.mjs custom-evm --chain-id 12345 --output candidate.json
  node node/chains.mjs plans --all --output NEW_DIRECTORY
  node node/chains.mjs plans --chain eip155:84532 --output NEW_DIRECTORY
  node node/chains.mjs inspect-build --input compiler-input.json --build compiler-output.json
Registry entries are not deployed, audited or automatically tradeable.
`;
function flags(args){const out={};for(let i=0;i<args.length;i++){const k=args[i];check(/^--[a-z-]+$/.test(k)&&!Object.hasOwn(out,k),'ARGUMENT_INVALID');if(k==='--all')out[k]=true;else{check(typeof args[i+1]==='string'&&!args[i+1].startsWith('--'),'ARGUMENT_VALUE_REQUIRED');out[k]=args[++i];}}return out;}
async function json(file){check(typeof file==='string','INPUT_REQUIRED');const s=await fs.stat(file);check(s.isFile()&&s.size<=16*1024*1024,'INPUT_SIZE_LIMIT');try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{throw new Error('INPUT_JSON_INVALID');}}
async function write(file,value){check(typeof file==='string','OUTPUT_REQUIRED');await fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
function checkFlags(options,allowed){check(Object.keys(options).every(k=>allowed.includes(k)),'ARGUMENT_INVALID');}
export async function main(args=process.argv.slice(2)){
 const [cmd,...rest]=args;if(!cmd||['help','--help'].includes(cmd)){process.stdout.write(help);return;}
 const opts=flags(rest);
 const commands={list:['--registry'],inspect:['--registry','--chain'],probe:['--input','--registry'],'probe-many':['--input','--registry'],
  'import-evm':['--input','--output'],'custom-evm':['--chain-id','--output'],plans:['--registry','--chain','--all','--output'],
  'inspect-build':['--input','--build']};check(commands[cmd],'COMMAND_UNKNOWN');checkFlags(opts,commands[cmd]);
 const registry=makeRegistry(await json(opts['--registry']??path.join(root,'node/chains/profiles.json')));
 let result;
 if(cmd==='list')result={schema:'realdex.chain-capabilities.v1',count:registry.size,profiles:registry.list().map(p=>({...p,capabilities:capabilities(p)})),executable:false};
 if(cmd==='inspect'){const p=registry.get(opts['--chain']);result={profile:p,capabilities:capabilities(p)};}
 const bind=req=>{check(req&&req.schema==='realdex.chain-probe-request.v1'&&Object.keys(req).every(k=>['schema','chainId','endpoints','genesisPin','policy'].includes(k)),'REQUEST_INVALID');return {profile:registry.get(req.chainId),endpoints:req.endpoints,...(req.genesisPin?{genesisPin:req.genesisPin}:{}),policy:req.policy??{}};};
 if(cmd==='probe'){result=await observeChain(bind(await json(opts['--input'])));}
 if(cmd==='probe-many'){const data=await json(opts['--input']);check(data.schema==='realdex.chain-probe-jobs.v1'&&Array.isArray(data.jobs),'REQUEST_INVALID');result=await observeMany(data.jobs.map(bind));}
 if(cmd==='import-evm'){const raw=await json(opts['--input']);result=importEvmCatalogue(raw);check(result.profiles.length>0,'NO_VALID_CHAINS');await write(opts['--output'],result);result={accepted:result.profiles.length,rejected:result.rejected,executable:false};}
 if(cmd==='custom-evm'){const p=customEvmProfile(opts['--chain-id']);await write(opts['--output'],{schema:'realdex.chain-candidates.v1',profiles:[p]});result={profile:p,executable:false};}
 if(cmd==='plans'){
  check(Boolean(opts['--all'])!==Boolean(opts['--chain']),'SELECT_ALL_OR_ONE_CHAIN');check(typeof opts['--output']==='string','OUTPUT_REQUIRED');
  const selected=opts['--all']?registry.list().filter(p=>p.family==='evm'&&p.status!=='deprecated'):[registry.get(opts['--chain'])];
  const sources=Object.fromEntries(await Promise.all(CONTRACTS.map(async c=>[c.source,await fs.readFile(path.join(root,c.source),'utf8')])));
  const input=makeCompilerInput(sources),plans=selected.map(p=>planEvmDeployment(p,input)),destination=path.resolve(opts['--output']);
  await fs.mkdir(destination,{recursive:false});
  await write(path.join(destination,'compiler-input.json'),input);
  for(const plan of plans)await write(path.join(destination,plan.network.id.replace(':','-')+'.json'),plan);
  const manifest={schema:'realdex.evm-plan-bundle.v1',count:plans.length,sourceSha256:Object.fromEntries(CONTRACTS.map(c=>[c.source,createHash('sha256').update(sources[c.source]).digest('hex')])),plans:plans.map(p=>p.network.id),compiled:false,deployed:false,executable:false};
  await write(path.join(destination,'bundle.json'),manifest);result=manifest;
 }
 if(cmd==='inspect-build')result=inspectCompilerOutput(await json(opts['--input']),await json(opts['--build']));
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
