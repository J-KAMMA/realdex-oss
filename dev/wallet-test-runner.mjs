/** Bounded wallet-test scheduling only; no product cryptography or wallet state changes. */
import fs from 'node:fs';
import path from 'node:path';
import {availableParallelism} from 'node:os';
import {spawnSync} from 'node:child_process';
import {testEnvironment} from '../app/lib/parallel-process.mjs';

const requireValue=(condition,code)=>{if(!condition)throw Error(code);};
export const MAX_WALLET_TEST_JOBS=2;

/** Only complete-suite execution is supported. --jobs 1 reproduces serial scheduling. */
export function walletTestPlan(directory,args=[],{cpuCount=availableParallelism()}={}) {
  requireValue(Array.isArray(args)&&args.every(x=>typeof x==='string'),'WALLET_TEST_ARGUMENTS');
  requireValue(args.length===0||(args.length===2&&args[0]==='--jobs'&&['1','2'].includes(args[1])),
    'WALLET_TEST_ARGUMENTS');
  requireValue(Number.isSafeInteger(cpuCount)&&cpuCount>=1,'WALLET_TEST_CPU_COUNT');
  requireValue(typeof directory==='string'&&path.isAbsolute(directory),'WALLET_TEST_DIRECTORY');
  const entries=fs.readdirSync(directory,{withFileTypes:true})
    .filter(entry=>entry.name.endsWith('.test.mjs')).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  requireValue(entries.length>0&&entries.length<=512,'WALLET_TEST_DISCOVERY');
  for(const entry of entries)requireValue(entry.isFile()&&!entry.isSymbolicLink(),
    'WALLET_TEST_NONREGULAR_FILE');
  const files=entries.map(entry=>path.join(directory,entry.name));
  const concurrency=Math.min(args.length?Number(args[1]):MAX_WALLET_TEST_JOBS,cpuCount,files.length);
  return Object.freeze({schema:'realdex.wallet-test-plan.v1',concurrency,isolation:'process',
    files:Object.freeze(files),args:Object.freeze(['--test',`--test-concurrency=${concurrency}`,
      '--experimental-test-isolation=process','--test-reporter=tap',...files])});
}

/** Keep Node's single TAP stream and exit semantics, including failure/signal/timeout errors. */
export function runWalletTests(directory,args=[],{cpuCount=availableParallelism(),run=spawnSync,
  environment=process.env,write=message=>process.stdout.write(message)}={}) {
  const plan=walletTestPlan(directory,args,{cpuCount});
  // TAP comment only; no generated summary, test filtering, shards, retries or force-exit.
  write(`# RealDEX wallet test files=${plan.files.length} concurrency=${plan.concurrency} isolation=process\n`);
  const result=run(process.execPath,[...plan.args],{stdio:'inherit',shell:false,env:testEnvironment(environment)});
  if(result?.error||result?.signal||!Number.isInteger(result?.status)||result.status<0||result.status>255)return 1;
  return result.status;
}
