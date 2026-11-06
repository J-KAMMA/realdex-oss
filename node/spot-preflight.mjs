#!/usr/bin/env node
/** Explicit public-data disclosure only. No keys, signing, broadcasts or file writes. */
import fs from 'node:fs';import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseExactJson} from './extended/json.mjs';
import {accessPolicy} from './extended/guard.mjs';
import {observeAndPreflightInjectiveOrder} from './external/injective-preflight.mjs';
export async function preflightCli(args){
 let filename;const allowedOrigins=[];
 for(let i=0;i<args.length;i++){
  const key=args[i],value=args[++i];if(!value||value.startsWith('--'))throw Error('INJ_CLI_ARGUMENTS');
  if(key==='--request'&&!filename)filename=value;
  else if(key==='--allow-remote'&&!allowedOrigins.includes(value))allowedOrigins.push(value);
  else throw Error('INJ_CLI_ARGUMENTS');
 }
 if(!filename)throw Error('INJ_CLI_REQUEST_REQUIRED');
 const access=accessPolicy(allowedOrigins.length?{mode:'explicit-remote',allowedOrigins}:{}),p=path.resolve(filename),s=fs.lstatSync(p);
 if(!s.isFile()||s.nlink!==1||s.size>262144||fs.realpathSync(p)!==p)throw Error('INJ_CLI_FILE');
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let raw;
 try{const a=fs.fstatSync(fd);if(a.dev!==s.dev||a.ino!==s.ino||a.size!==s.size)throw Error('INJ_CLI_FILE_CHANGED');raw=Buffer.alloc(s.size+1);const n=fs.readSync(fd,raw,0,raw.length,0);if(n!==s.size)throw Error('INJ_CLI_FILE_CHANGED');raw=raw.subarray(0,n);}finally{fs.closeSync(fd);}
 const data=parseExactJson(new TextDecoder('utf-8',{fatal:true}).decode(raw),{maxChars:262144,maxNodes:5000,maxDepth:16});
 return observeAndPreflightInjectiveOrder(data,{access});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await preflightCli(process.argv.slice(2)),null,2));}
 catch(e){console.error(e instanceof Error&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:'INJ_PREFLIGHT_FAILED');process.exitCode=1;}
}
