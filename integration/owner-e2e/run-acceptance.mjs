#!/usr/bin/env node
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {runOwnerAcceptance} from './acceptance.mjs';
export function parseAcceptanceArgs(args){
 const names={'--profile':'profile','--runtime-dir':'runtime','--output':'output','--expect-commit':'expectedCommit','--expect-tree':'expectedTree'},o={};
 for(let i=0;i<args.length;i+=2){const k=names[args[i]],v=args[i+1];if(!k||typeof v!=='string'||v.startsWith('--')||Object.hasOwn(o,k))throw Error('E2E_ACCEPTANCE_ARGUMENTS');o[k]=v;}
 if(Object.keys(o).length!==5||!['api','browser'].includes(o.profile))throw Error('E2E_ACCEPTANCE_ARGUMENTS');return o;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const r=await runOwnerAcceptance(parseAcceptanceArgs(process.argv.slice(2)));console.log(JSON.stringify({requestedScopePassed:r.requestedScopePassed,apiPassed:r.apiPassed,browserEndToEndPassed:r.browserEndToEndPassed,commit:r.commit,tree:r.tree}));process.exitCode=r.requestedScopePassed?0:2;}
 catch(e){console.error(e instanceof Error&&/^E2E_[A-Z0-9_]{1,80}$/.test(e.message)?e.message:'E2E_ACCEPTANCE_FAILED');process.exitCode=1;}
}
