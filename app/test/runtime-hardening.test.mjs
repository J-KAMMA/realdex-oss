import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {isolatedServiceEnvironment} from '../runtime.mjs';

test('Shared services receive no wallet, AI, cloud, proxy or Node preload credentials',()=>{
 const source={PATH:process.env.PATH,HOME:'/home/example',REALDEX_AGENT_TOKEN:'sentinel-agent',
 REALDEX_V01_SIGNER_PRIVATE_KEY:'sentinel-signing',MAINNET_RPC_URL:'sentinel-rpc',NODE_OPTIONS:'--require=untrusted',
 OPENAI_API_KEY:'sentinel-api',AWS_SECRET_ACCESS_KEY:'sentinel-cloud',HTTP_PROXY:'sentinel-proxy'};
 const result=isolatedServiceEnvironment(source);
 assert.deepEqual(result,{PATH:source.PATH,HOME:source.HOME});assert.equal(source.REALDEX_AGENT_TOKEN,'sentinel-agent');
});
test('A real child process cannot observe filtered credential variables',()=>{
 const environment=isolatedServiceEnvironment({...process.env,REALDEX_AGENT_TOKEN:'sentinel-agent',NODE_OPTIONS:'--this-must-never-be-inherited'});
 const child=spawnSync(process.execPath,['--input-type=module','-e','console.log(JSON.stringify({token:process.env.REALDEX_AGENT_TOKEN??null,options:process.env.NODE_OPTIONS??null}))'],{encoding:'utf8',env:environment,shell:false});
 assert.equal(child.status,0);assert.deepEqual(JSON.parse(child.stdout),{token:null,options:null});
});
test('Required Windows environment names are preserved without broad prefix forwarding',()=>{
 const env=isolatedServiceEnvironment({SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',USERPROFILE:'C:\\Users\\test',TEMP:'C:\\Temp',TMP:'C:\\Tmp',REALDEX_PRIVATE:'secret'});
 assert.equal(env.SystemRoot,'C:\\Windows');assert.equal(env.USERPROFILE,'C:\\Users\\test');assert.equal(Object.keys(env).length,5);
});
test('Inherited object properties are not forwarded as process settings',()=>{
 const source=Object.assign(Object.create({PATH:'inherited',HOME:'inherited'}),{LANG:'C'});assert.deepEqual(isolatedServiceEnvironment(source),{LANG:'C'});
});
