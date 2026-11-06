#!/usr/bin/env node
/** Cross-platform test entry: does not depend on a shell expanding *.test.mjs. */
import {readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const directory=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(directory,'../..');
const args=process.argv.slice(2);
if(args.some(x=>!['--verified-only','--with-release'].includes(x)) || new Set(args).size!==args.length) {
  console.error('Usage: node node/test/run-tests.mjs [--verified-only] [--with-release]');process.exitCode=1;
} else {
  const tests=readdirSync(directory).filter(x=>x.endsWith('.test.mjs')&&(!args.includes('--verified-only')||x.startsWith('verified-'))).sort().map(x=>path.join(directory,x));
  if(!tests.length){
    console.error('TEST_DISCOVERY_EMPTY');process.exitCode=1;
  }else{
    if(args.includes('--with-release'))tests.push(path.join(root,'scripts/createEvmTestnetReleasePlan.test.mjs'));
    // Node >=23 defaults to spec even on non-TTY stdout; CI requires TAP.
    // Bound inner concurrency as well as app/ci.mjs's outer suite pool.
    const result=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',...tests],{cwd:root,stdio:'inherit',shell:false});
    if(result.error){console.error('TEST_PROCESS_FAILED');process.exitCode=1;}else process.exitCode=result.status??1;
  }
}
