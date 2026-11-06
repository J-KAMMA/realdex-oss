#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {check,keys,extensionError} from './extended/guard.mjs';
import {extendedRegistry,extendedCapabilities,privateEvmProfile,privateCometProfile} from './extended/registry.mjs';
import {observeExtended} from './extended/observe.mjs';
import {observeIcrcLedger} from './icp/reader.mjs';
import {quoteIcrcPool} from './icp/planning.mjs';
import {selectPolicyRoute} from './extended/route-policy.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url));
const HELP=`RealDEX ICP / privacy extension (NO signing, sending or wallet-scanning)
  node node/privacy.mjs list [--registry networks.json]
  node node/privacy.mjs ledgers
  node node/privacy.mjs probe --input request.json [--registry networks.json]
  node node/privacy.mjs icrc --input metadata-request.json
  node node/privacy.mjs quote-icrc --input model-input.json
  node node/privacy.mjs screen-routes --input route-claims.json
  node node/privacy.mjs private-evm --input network.json --output NEW_FILE.json
  node node/privacy.mjs private-comet --input network.json --output NEW_FILE.json
Default endpoint access is literal loopback only. Explicit HTTPS origins need consent.
Use an endpoint's authEnv field for an Authorization header read from a local env var.
Never put a spending/viewing key, mnemonic, RPC password or bearer token in JSON.
`;
async function read(file){check(typeof file==='string','INPUT_REQUIRED');const st=await fs.stat(file);check(st.isFile()&&st.size<=2097152,'INPUT_SIZE_LIMIT');let d;
 try{d=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw Error('INPUT_JSON_INVALID');}return d;}
function flags(args){const o={};for(let i=0;i<args.length;i+=2){check(['--input','--output','--registry'].includes(args[i])&&!Object.hasOwn(o,args[i])&&typeof args[i+1]==='string'&&!args[i+1].startsWith('--'),'ARGUMENT_INVALID');o[args[i]]=args[i+1];}return o;}
function endpoints(raw,env){check(Array.isArray(raw),'ENDPOINTS_INVALID');return raw.map(e=>{if(typeof e==='string')return e;keys(e,['url'],['authEnv']);
 if(e.authEnv===undefined)return {url:e.url};check(typeof e.authEnv==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(e.authEnv),'AUTH_ENV_NAME_INVALID');
 const secret=env[e.authEnv];check(typeof secret==='string'&&secret.length>0,'AUTH_ENV_MISSING');return {url:e.url,headers:{authorization:secret}};});}
export async function main(args=process.argv.slice(2),env=process.env){
 const [cmd,...rest]=args;if(!cmd||cmd==='--help'||cmd==='help'){process.stdout.write(HELP);return;}
 const commands={list:['--registry'],ledgers:[],probe:['--registry','--input'],icrc:['--input'],'quote-icrc':['--input'],'screen-routes':['--input'],'private-evm':['--input','--output'],'private-comet':['--input','--output']};
 check(Object.hasOwn(commands,cmd),'COMMAND_INVALID');const f=flags(rest);check(Object.keys(f).every(k=>commands[cmd].includes(k)),'ARGUMENT_INVALID');let result;
 if(cmd==='list'){const registry=extendedRegistry(await read(f['--registry']??path.join(directory,'extended/networks.json')));result={count:registry.size,profiles:registry.list().map(p=>({profile:p,capabilities:extendedCapabilities(p)})),executable:false};}
 else if(cmd==='ledgers')result=await read(path.join(directory,'icp/ledgers.json'));
 else {const r=await read(f['--input']);
  if(cmd==='probe'){keys(r,['schema','networkId','endpoints'],['access','genesisPin','identityAnchor','ledger','policy']);check(r.schema==='realdex.extended-probe-request.v1','REQUEST_SCHEMA_INVALID');
   const registry=extendedRegistry(await read(f['--registry']??path.join(directory,'extended/networks.json')));result=await observeExtended({profile:registry.get(r.networkId),endpoints:endpoints(r.endpoints,env),access:r.access,genesisPin:r.genesisPin,identityAnchor:r.identityAnchor,ledger:r.ledger,policy:r.policy});}
  if(cmd==='icrc'){keys(r,['schema','network','ledger','endpoints'],['access']);check(r.schema==='realdex.icrc-request.v1','REQUEST_SCHEMA_INVALID');result=await observeIcrcLedger({...r,endpoints:endpoints(r.endpoints,env)});}
  if(cmd==='quote-icrc')result=quoteIcrcPool(r);
  if(cmd==='screen-routes'){keys(r,['schema','routes','request'],['policy']);check(r.schema==='realdex.route-claims.v1','REQUEST_SCHEMA_INVALID');result=selectPolicyRoute(r.routes,r.request,r.policy);}
  if(['private-evm','private-comet'].includes(cmd)){
   keys(r,cmd==='private-evm'?['slug','chainId','genesisHash']:['slug','chainId','checkpointHash'],['name']);
   result={schema:'realdex.extended-networks.v1',profiles:[cmd==='private-evm'?privateEvmProfile(r):privateCometProfile(r)]};
   check(typeof f['--output']==='string','OUTPUT_REQUIRED');await fs.writeFile(f['--output'],JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  }
 }
 process.stdout.write(JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(extensionError(e));process.exitCode=1;});
