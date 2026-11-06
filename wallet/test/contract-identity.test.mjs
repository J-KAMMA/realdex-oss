/** SYNTHETIC compiler-shaped data. These tests do not execute Solidity or an EVM. */
import test from 'node:test';import assert from 'node:assert/strict';
import {buildPoolIdentity,validatePoolIdentity,instantiatePoolIdentity,inspectPoolIdentity} from '../lib/contract-identity.mjs';
import {canonical} from '../lib/guard.mjs';import {sha256} from '../lib/keys.mjs';
import {keccak256,selector} from '../../node/verified/keccak.mjs';import {abiAddress,abiWord} from '../lib/transactions.mjs';
const F='0x'+'11'.repeat(20),A='0x'+'22'.repeat(20),B='0x'+'33'.repeat(20),H='0x'+'44'.repeat(32);
function fixture(){
  const names=['factory','token0','token1','feeBasisPoints'],sourceNames=['LocalSwapFactory','LocalSwapPool','LocalSwapRouter'];
  const sources=Object.fromEntries(sourceNames.map(n=>['contracts/'+n+'.sol','// synthetic '+n]));
  const info={solcLongVersion:'0.8.24+commit.e11b9ed9',input:{language:'Solidity',settings:{optimizer:{enabled:true,runs:500}},sources:Object.fromEntries(Object.entries(sources).map(([k,content])=>[k,{content}]))},output:{contracts:{},sources:{}}};
  const evm=(runtime,creation='6001')=>({bytecode:{object:creation,linkReferences:{}},deployedBytecode:{object:runtime,linkReferences:{},immutableReferences:{}}});
  info.output.contracts['contracts/LocalSwapFactory.sol']={LocalSwapFactory:{evm:evm('600260016003')}};
  info.output.contracts['contracts/LocalSwapRouter.sol']={LocalSwapRouter:{evm:evm('6004')}};
  const pool=evm('00'.repeat(132));pool.deployedBytecode.immutableReferences=Object.fromEntries(names.map((_,i)=>[i+1,[{start:i*32,length:32}]]));info.output.contracts['contracts/LocalSwapPool.sol']={LocalSwapPool:{evm:pool}};
  info.output.sources['contracts/LocalSwapPool.sol']={ast:{nodes:[{nodeType:'ContractDefinition',name:'LocalSwapPool',nodes:names.map((name,i)=>({nodeType:'VariableDeclaration',name,mutability:'immutable',id:i+1}))}]}};
  const anchors={factoryRuntimeCodeHash:keccak256('0x600260016003'),routerRuntimeCodeHash:keccak256('0x6004')};
  return {info,sources,anchors,build:()=>buildPoolIdentity(info,{sources,expectedRuntimeHashes:anchors})};
}
test('Compiler artifact extraction binds exact sources, runtime anchors and all four immutable references',()=>{
  const f=fixture(),r=f.build();assert.equal(r.identity.buildReproducedHere,false);assert.equal(validatePoolIdentity(r.identity,r.sha256).compiler,'0.8.24+commit.e11b9ed9');assert.equal(Object.keys(r.identity.immutableReferences).length,4);
});
for(const [name,mutate,pattern] of [
  ['source bytes',f=>f.sources['contracts/LocalSwapPool.sol']+=' changed',/SOURCE_BYTES/],
  ['compiler version',f=>f.info.solcLongVersion='0.8.25',/VERSION/],
  ['optimizer',f=>f.info.input.settings.optimizer.runs=200,/SETTINGS/],
  ['compile error',f=>f.info.output.errors=[{severity:'error'}],/CONTAINS_ERRORS/],
  ['runtime anchor',f=>f.anchors.factoryRuntimeCodeHash=H,/ANCHOR/],
  ['pool creation mismatch',f=>f.info.output.contracts['contracts/LocalSwapPool.sol'].LocalSwapPool.evm.bytecode.object='6005',/EMBED/],
  ['missing immutable',f=>delete f.info.output.contracts['contracts/LocalSwapPool.sol'].LocalSwapPool.evm.deployedBytecode.immutableReferences['1'],/METADATA/],
  ['overlap',f=>f.info.output.contracts['contracts/LocalSwapPool.sol'].LocalSwapPool.evm.deployedBytecode.immutableReferences['2'][0].start=0,/OVERLAP/],
  ['range overflow',f=>f.info.output.contracts['contracts/LocalSwapPool.sol'].LocalSwapPool.evm.deployedBytecode.immutableReferences['2'][0].start=1000,/RANGE/],
  ['linked library',f=>f.info.output.contracts['contracts/LocalSwapPool.sol'].LocalSwapPool.evm.bytecode.linkReferences={x:{}},/LINKED/],
])test(`Identity rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(f.build,pattern);});
test('Immutable substitution patches only designated bytes and changes identity for each fee tier',()=>{
  const {identity,sha256}=fixture().build();const request={chainId:'31337',factory:F,tokenA:B,tokenB:A,feeBps:1};
  const r=instantiatePoolIdentity(identity,sha256,request);assert.equal(r.token0,A);assert.equal(r.expectedRuntime,'0x'+abiAddress(F)+abiAddress(A)+abiAddress(B)+abiWord(1)+'00'.repeat(4));
  assert.notEqual(instantiatePoolIdentity(identity,sha256,{...request,feeBps:2}).expectedPool,r.expectedPool);
  assert.notEqual(instantiatePoolIdentity(identity,sha256,{...request,factory:A}).runtimeHash,r.runtimeHash);
});
test('Changing a stored identity without a new independent local digest is refused',()=>{
  const {identity,sha256}=fixture().build();identity.warning='tampered';assert.throws(()=>validatePoolIdentity(identity,sha256),/DIGEST/);
});
test('Anchored RPC identity observation checks both factory mappings, runtime and getters; grants no execution',async()=>{
  const {identity,sha256}=fixture().build(),request={factory:F,tokenA:A,tokenB:B,feeBps:1};const expected=instantiatePoolIdentity(identity,sha256,{...request,chainId:'31337'});let corrupt=false;
  const rpc={snapshot:async()=>({hash:H,number:'0x10',ref:{blockHash:H,requireCanonical:true}}),agree:async(_n,method,params)=>{
    if(method==='eth_getBlockByNumber')return {number:'0x10',hash:H};
    if(method==='eth_getCode')return params[0]===F?'0x600260016003':corrupt?'0x6000':expected.expectedRuntime;
    const call=params[0];if(call.to===F)return '0x'+abiAddress(expected.expectedPool);
    const values={factory:abiAddress(F),token0:abiAddress(A),token1:abiAddress(B),feeBasisPoints:abiWord(1)};
    for(const [name,value]of Object.entries(values))if(call.data===selector(name+'()'))return '0x'+value;throw Error('UNEXPECTED_CALL');
  }};
  const result=await inspectPoolIdentity(rpc,{chainId:'31337',genesisHash:H},identity,sha256,request);assert.equal(result.poolRuntimeMatched,true);assert.equal(result.create2AddressMatched,true);assert.equal(result.executable,false);assert.equal(result.compilerReproducedHere,false);
  corrupt=true;await assert.rejects(inspectPoolIdentity(rpc,{chainId:'31337',genesisHash:H},identity,sha256,request),/RUNTIME_IDENTITY/);
});
