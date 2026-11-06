import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {testEnvironment} from '../lib/parallel-process.mjs';
const script=fileURLToPath(new URL('../../scripts/checkContractCallArity.mjs',import.meta.url));
function check(t,call){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'realdex arity '));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['contracts','scripts','src'])fs.mkdirSync(path.join(root,dir));
  fs.copyFileSync(script,path.join(root,'scripts/checkContractCallArity.mjs'));
  fs.writeFileSync(path.join(root,'contracts/Fixture.sol'),`contract Fixture {
    function getAddress(address owner, bytes32 salt) public view returns (address) {}
    function createPool(address a, address b, uint256 fee) external returns (address) {}
    mapping(address => mapping(address => mapping(uint256 => address))) public getPool;
  }`);
  fs.writeFileSync(path.join(root,'src/fixture.ts'),call+';\n');
  const result=spawnSync(process.execPath,['scripts/checkContractCallArity.mjs','--json'],{cwd:root,env:testEnvironment(),encoding:'utf8',timeout:10000,shell:false});
  assert.equal(result.signal,null);assert.equal(result.error,undefined);
  return {status:result.status,...JSON.parse(result.stdout)};
}
for(const receiver of ['factory','router','token','pool'])test('ethers '+receiver+'.getAddress() is not the Solidity factory function',t=>{
  const r=check(t,receiver+'.getAddress()');assert.equal(r.status,0);assert.deepEqual(r.findings,[]);assert.equal(r.hostMethodArities.getAddress,0);
});
for(const args of ['owner','owner, salt','owner, salt, extra'])test('direct getAddress('+args+') cannot silently select the ABI method',t=>{
  const r=check(t,'factory.getAddress('+args+')');assert.equal(r.status,1);assert.equal(r.findings.length,1);assert.equal(r.findings[0].expected,0);assert.equal(r.findings[0].binding,'ethers-host');
});
for(const quote of ['"',"'"])test('explicit Solidity getAddress accepts two arguments with '+quote,t=>{
  const r=check(t,`factory.getFunction(${quote}getAddress${quote})(owner, salt)`);assert.equal(r.status,0);assert.deepEqual(r.findings,[]);
});
for(const args of ['', 'owner', 'owner, salt, extra'])test('explicit Solidity getAddress rejects wrong arity: '+args,t=>{
  const r=check(t,`factory.getFunction("getAddress")(${args})`);assert.equal(r.status,1);assert.equal(r.findings.length,1);assert.equal(r.findings[0].expected,2);assert.equal(r.findings[0].binding,'explicit-solidity');
});
for(const name of ['createPool','getPool']){
  test(name+' still catches the original missing fee regression',t=>{
    const r=check(t,`factory.${name}(a,b)`);assert.equal(r.status,1);assert.equal(r.findings[0].expected,3);
  });
  test(name+' accepts three arguments including nested ethers address calls',t=>{
    const r=check(t,`factory.${name}(await tokenA.getAddress(),await tokenB.getAddress(),300)`);assert.equal(r.status,0);assert.deepEqual(r.findings,[]);
  });
  test('explicit '+name+' also catches a missing fee',t=>{
    const r=check(t,`factory.getFunction('${name}')(a,b)`);assert.equal(r.status,1);assert.equal(r.findings[0].expected,3);
  });
}
test('unrelated receivers are outside the heuristic, not treated as ethers',t=>{
  const r=check(t,'unrelated.getAddress(owner,salt)');assert.equal(r.status,0);assert.deepEqual(r.findings,[]);
});
