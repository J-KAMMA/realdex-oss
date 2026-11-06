/** Isolated contract probes. Experimental output NEVER enters the production compiler gate. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {compilerInput} from '../compile-local.mjs';
import stable from '../compiler-pin.cjs';
import experimental from './experimental-pin.json' with {type:'json'};
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
const sha = b => createHash('sha256').update(b).digest('hex');
export function compileProbe({profile = 'pinned', compiler, root = ROOT} = {}) {
  if (!['pinned', 'experimental'].includes(profile)) throw Error('AMM_COMPILER_PROFILE_INVALID');
  const input = compilerInput(root), text = JSON.stringify(input);
  const env = {PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C'};
  let result, version, compilerSha256;
  if (profile === 'pinned') {
    const checked = stable.verifiedCompiler(compiler);
    result = spawnSync(checked.compilerPath, ['--standard-json'], {input:text, encoding:'utf8', timeout:120000, maxBuffer:33554432, env, shell:false});
    version = stable.PIN.longVersion; compilerSha256 = stable.PIN.sha256;
  } else {
    if (typeof compiler !== 'string' || !compiler) throw Error('EXPERIMENTAL_COMPILER_NOT_CONFIGURED');
    result = spawnSync(process.execPath, [path.join(here,'compile-worker.cjs'), path.resolve(compiler)], {input:text, encoding:'utf8', timeout:120000, maxBuffer:33554432, env, shell:false});
    version = experimental.version; compilerSha256 = experimental.sha256;
  }
  if (result.status !== 0 || result.error) throw Error('AMM_COMPILER_EXECUTION_FAILED: ' + String(result.stderr ?? '').trim().slice(0,200));
  const response = JSON.parse(result.stdout), output = profile === 'pinned' ? response : response.output;
  if (profile === 'experimental' && response.version !== experimental.version) throw Error('AMM_COMPILER_VERSION_MISMATCH');
  if ((output.errors ?? []).some(e => e.severity === 'error')) throw Error('AMM_COMPILATION_FAILED: ' + output.errors.filter(e=>e.severity==='error').map(e=>e.formattedMessage).join('\n'));
  for (const name of ['LocalSwapFactory','LocalSwapPool','LocalSwapRouter']) if (!output.contracts?.[`contracts/${name}.sol`]?.[name]?.evm?.bytecode?.object) throw Error('AMM_COMPILER_CONTRACT_MISSING');
  return {solcLongVersion:version, solcVersion:profile==='pinned'?'0.8.24':version.split('+')[0],input,output,
    evidence:{profile,compilerSha256,compilerVersion:version,inputSha256:sha(text),outputSha256:sha(result.stdout),
      sourceHashes:Object.fromEntries(Object.entries(input.sources).map(([name,v])=>[name,sha(v.content)])),
      settings:input.settings,experimentalOnly:profile==='experimental',productionReady:false}};
}
export function environmentCompilation() {
  const profile = process.env.REALDEX_AMM_PROFILE ?? 'pinned';
  return compileProbe({profile, compiler: profile === 'experimental' ? process.env.REALDEX_EXPERIMENTAL_SOLJSON : process.env.REALDEX_SOLC_BINARY});
}
