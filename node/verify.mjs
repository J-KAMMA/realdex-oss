#!/usr/bin/env node
import fs from 'node:fs';
import { need } from './shared/protocol-core.mjs';
import { runReadOnlyRequest } from './verified/workflow.mjs';

async function main() {
  const args=process.argv.slice(2);
  if(args.length===0 || (args.length===1 && ['--help','help'].includes(args[0]))) {
    console.log('RealDEX read-only verification (no custody / approval / wallet / signing / send)\n'+
      '  node node/verify.mjs --config your-request.json [--output new-report.json]\n'+
      'See node/examples/readonly-request.example.json. Fill public keys, tokens and your own RPC endpoints.\n'+
      'Exit 0: observed pools (not execution approval); 3: no verified pools; 1: validation/read failure.\n'+
      'Existing output files are never overwritten.');return;
  }
  const options={};while(args.length){const key=args.shift();need(['--config','--output'].includes(key)&&!Object.hasOwn(options,key),'ARGUMENT_INVALID');
    const value=args.shift();need(value && !value.startsWith('--'),'ARGUMENT_VALUE_MISSING');options[key]=value;}
  need(options['--config'],'CONFIG_REQUIRED');
  const fd=fs.openSync(options['--config'],'r');let input;
  try {const stat=fs.fstatSync(fd);need(stat.isFile()&&stat.size<=32768,'CONFIG_FILE_INVALID');const bytes=Buffer.alloc(32769);let length=0,n;
    while(length<bytes.length && (n=fs.readSync(fd,bytes,length,bytes.length-length,null))>0) length+=n;
    need(length<=32768,'CONFIG_FILE_INVALID');try {input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));}catch {throw new Error('CONFIG_JSON_INVALID');}
  } finally {fs.closeSync(fd);}
  const abort=new AbortController();const stop=()=>abort.abort(new Error('READONLY_REQUEST_CANCELLED'));
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    const report=await runReadOnlyRequest(input,{signal:abort.signal});
    const text=JSON.stringify(report,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
    if(options['--output']) fs.writeFileSync(options['--output'],text,{flag:'wx',mode:0o600});
    else process.stdout.write(text);
    if(report.status==='no-verified-pools')process.exitCode=3;
  } finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
main().catch(error=>{const code=error instanceof Error&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:
  error?.code==='EEXIST'?'OUTPUT_EXISTS_NOT_OVERWRITTEN':'READONLY_OPERATION_FAILED';
  console.error(JSON.stringify({error:code,executable:false,walletSigning:false}));process.exitCode=1;});
