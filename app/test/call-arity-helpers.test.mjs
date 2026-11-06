import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {testEnvironment} from '../lib/parallel-process.mjs';

const script=fileURLToPath(new URL('../../scripts/checkContractCallArity.mjs',import.meta.url));
const helpers=['staticCall','staticCallResult','send','estimateGas','populateTransaction'];
const declaration=`contract Fixture {
  function createPool(address a, address b, uint256 fee) external returns (address) {}
  function getAddress(address owner, bytes32 salt) public view returns (address) {}
  function one(bytes value) external {}
  mapping(address => mapping(address => mapping(uint256 => address))) public getPool;
}`;
function check(t,code,solidity=declaration){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'realdex arity helpers '));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['src','scripts','contracts'])fs.mkdirSync(path.join(root,dir));
  fs.copyFileSync(script,path.join(root,'scripts/checkContractCallArity.mjs'));
  fs.writeFileSync(path.join(root,'src/fixture.ts'),code);
  fs.writeFileSync(path.join(root,'contracts/Fixture.sol'),solidity);
  const r=spawnSync(process.execPath,['scripts/checkContractCallArity.mjs','--json'],{
    cwd:root,env:testEnvironment(),encoding:'utf8',shell:false,timeout:10000,maxBuffer:1048576
  });
  assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.notEqual(r.status,null);
  return {...JSON.parse(r.stdout),status:r.status};
}
for(const helper of helpers)for(const explicit of [false,true]){
  const access=explicit?'factory.getFunction("createPool")':'factory.createPool';
  for(const [args,expected] of [['a,b',1],['a,b,300',0],['a,b,300,extra',1],['a,b,300,{gasLimit:100000n}',0]]){
    test(`${access}.${helper}(${args}) preserves argument checks`,t=>{
      const r=check(t,`${access}.${helper}(${args});`);
      assert.equal(r.status,expected);assert.equal(r.matchedCalls,1);
      assert.equal(r.findings.length,expected);
      if(expected){assert.equal(r.findings[0].expected,3);assert.equal(r.findings[0].reason,'ARGUMENT_COUNT_MISMATCH');}
    });
  }
  test(`getAddress host/ABI collision via ${helper} (${explicit})`,t=>{
    const access=explicit?'factory.getFunction("getAddress")':'factory.getAddress';
    const r=check(t,`${access}.${helper}(owner,salt);`);
    assert.equal(r.status,explicit?0:1);
    if(!explicit)assert.equal(r.findings[0].reason,'HOST_METHOD_HAS_NO_CONTRACT_HELPER');
  });
}
for(const [label,code] of [
  ['trailing comma','factory.createPool(a,b,300,);'],
  ['comment after trailing comma','factory.createPool(a,b,300, /* ignored , ) */);'],
  ['comments in member access','factory /* gap */ . createPool . staticCall(a,b,300);'],
  ['literal selector with comments',`factory.getFunction(/* before */ 'createPool' /* after */).send(a,b,300);`],
  ['quoted punctuation',`factory.createPool('a,b)\\\'x', "b,]}", 300);`],
  ['nested calls','factory.createPool(await tokenA.getAddress(), fn([1,2],{a:3,b:4}),300);'],
  ['one array argument','contract.one([1,2]);'],
  ['one nested call argument','contract.one(fn());'],
  ['one object argument','contract.one({a:1,b:2});'],
  ['one quoted argument','contract.one("a,b)");'],
  ['template punctuation','contract.one(`a,b) ${fn(1,2)}`);'],
  ['nested template literals','contract.one(`a${`b${fn("}")}`}`);'],
  ['object overrides with punctuation','factory.createPool.populateTransaction(a,b,300,{customData:"x,})",gasLimit:fn(1,2)},);']
])test('Counting is stable with '+label,t=>{
  const r=check(t,code);assert.equal(r.status,0,JSON.stringify(r.findings));
  assert.ok(r.matchedCalls>=1);
});
for(const [label,code,reason] of [
  ['spread at start','factory.createPool(...args);','SPREAD_ARGUMENT_COUNT_UNRESOLVED'],
  ['spread at end','factory.createPool.staticCall(a,b,...args);','SPREAD_ARGUMENT_COUNT_UNRESOLVED'],
  ['spread across comment','factory.createPool(a,b,.../*comment*/ args);','SPREAD_ARGUMENT_COUNT_UNRESOLVED'],
  ['wrong closing delimiter','factory.createPool(a,b,300];','ARGUMENT_LIST_UNRESOLVED'],
  ['missing closing delimiter','factory.createPool(a,b,300','ARGUMENT_LIST_UNRESOLVED'],
  ['empty middle argument','factory.createPool(a,,300);','ARGUMENT_LIST_UNRESOLVED'],
  ['leading comma','factory.createPool(,a,b);','ARGUMENT_LIST_UNRESOLVED'],
  ['only commas','factory.createPool(,,);','ARGUMENT_LIST_UNRESOLVED'],
  ['object followed by another expression','factory.createPool(a,b,300,{} || {});','ARGUMENT_COUNT_MISMATCH'],
  ['unknown extra variable','factory.createPool(a,b,300,overrides);','ARGUMENT_COUNT_MISMATCH'],
  ['two overrides','factory.createPool(a,b,300,{},{});','ARGUMENT_COUNT_MISMATCH'],
  ['host method with object','contract.getAddress({});','ARGUMENT_COUNT_MISMATCH']
])test('Matched call fails closed: '+label,t=>{
  const r=check(t,code);assert.equal(r.status,1);assert.equal(r.findings.length,1);
  assert.equal(r.findings[0].reason,reason);
});
for(const code of [
  '// factory.createPool.staticCall(a,b);\n',
  '/* factory.createPool(a,b); */',
  `const x="factory.createPool(a,b)";`,
  "const x=`factory.createPool(a,b)`;",
  `const x='factory.getFunction("createPool").send(a,b)';`
])test('Comments/text do not introduce phantom calls: '+JSON.stringify(code),t=>{
  const r=check(t,code);assert.equal(r.status,0);assert.equal(r.matchedCalls,0);
});
test('Declarations inside Solidity comments cannot change arity',t=>{
  const r=check(t,'factory.createPool.staticCall(a,b);',declaration+'\n// function createPool(address a,address b) public {}');
  assert.equal(r.status,1);assert.equal(r.findings[0].expected,3);assert.deepEqual(r.overloadedSkipped,[]);
});
test('A finding keeps original source line numbers after multiline text/comments',t=>{
  const r=check(t,'const s=`one\ntwo`;\n/* comment\nmore */\nfactory.createPool.staticCall(a,b);');
  assert.equal(r.findings[0].line,5);
});
test('The existing receiver heuristic does not label an unrelated object a contract',t=>{
  const r=check(t,'object.createPool.staticCall(a,b);');assert.equal(r.status,0);assert.equal(r.matchedCalls,0);
});
test('Every supported helper still checks public nested-mapping getters',t=>{
  const r=check(t,helpers.map(x=>`factory.getPool.${x}(a,b);`).join('\n'));
  assert.equal(r.status,1);assert.equal(r.findings.length,5);assert.ok(r.findings.every(x=>x.expected===3));
});
test('Ordered generated corpus covers helper/selector/arity/nested-expression combinations',t=>{
  const names=['createPool','getPool'];
  const atoms=['a','fn(a,b)','[a,b]','{x:a,y:b}','"a,b)"','`a${fn(1,2)}`'];
  const lines=[];let expectedFailures=0;
  for(const name of names)for(const helper of helpers)for(const explicit of [false,true])for(let count=0;count<=5;count++){
    const access=explicit?`factory.getFunction('${name}')`:`factory.${name}`;
    const args=Array.from({length:count},(_,i)=>atoms[(i+count)%atoms.length]);
    // This corpus has no appended overrides. Keep the fourth argument scalar so
    // this arity-only oracle cannot mistake it for the syntactic overrides slot.
    if(count>=4)args[count-1]='extra';
    lines.push(`${access}.${helper}(${args.join(',')}${count?',':''});`);
    if(count!==3)expectedFailures++;
  }
  const r=check(t,lines.join('\n'));assert.equal(lines.length,120);
  assert.equal(r.matchedCalls,120);assert.equal(r.findings.length,expectedFailures);
  assert.ok(r.findings.every(x=>x.reason==='ARGUMENT_COUNT_MISMATCH'));
});
