import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveCreate2Address,deriveLocalPoolAddress} from '../verified/create2.mjs';
import {A,B,F} from './verified-fixtures.mjs';
const zero='0x'+'0'.repeat(40),salt='0x'+'0'.repeat(64),dead='0xdeadbeef'+'0'.repeat(32),endDead='0x'+'0'.repeat(32)+'deadbeef',cafe='0x'+'0'.repeat(56)+'cafebabe';
// Official EIP-1014 examples 0..6. Arithmetic vectors, not EVM execution.
const vectors=[
 [zero,salt,'0x00','0x4D1A2e2bB4F88F0250f26Ffff098B0b30B26BF38'],
 [dead,salt,'0x00','0xB928f69Bb1D91Cd65274e3c79d8986362984fDA3'],
 [dead,'0x000000000000000000000000feed000000000000000000000000000000000000','0x00','0xD04116cDd17beBE565EB2422F2497E06cC1C9833'],
 [zero,salt,'0xdeadbeef','0x70f2b2914A2a4b783FaEFb75f459A580616Fcb5e'],
 [endDead,cafe,'0xdeadbeef','0x60f3f640a8508fC6a86d45DF051962668E1e8AC7'],
 [endDead,cafe,'0x'+'deadbeef'.repeat(11),'0x1d8bfDC5D46DC4f61D6b6115972536eBE6A8854C'],
 [zero,salt,'0x','0xE33C0C7F7df4809055C3ebA6c09CFe4BaF1BD9e0']
];
for(const [i,v] of vectors.entries())test(`EIP-1014 official example ${i}`,()=>assert.equal(deriveCreate2Address(...v.slice(0,3)),v[3].toLowerCase()));
const args={chainId:'eip155:84532',factory:F,tokenA:A,tokenB:B,feeBps:5,poolCreationCode:'0x60006000f3'};
test('LocalSwap pair order is canonical, fee creates a distinct address, no authenticity implied',()=>{
 const a=deriveLocalPoolAddress(args),b=deriveLocalPoolAddress({...args,tokenA:B,tokenB:A}),c=deriveLocalPoolAddress({...args,feeBps:30});
 assert.deepEqual(a,b);assert.notEqual(a.expectedPool,c.expectedPool);assert.equal(a.deploymentProven,false);assert.equal(a.creationCodeAuthenticated,false);assert.equal(a.executable,false);assert(Object.isFrozen(a));
});
for(const patch of [{chainId:'solana:test'},{factory:zero},{tokenB:A},{feeBps:0},{feeBps:101},{feeBps:5n},{poolCreationCode:'0x'},{poolCreationCode:'0x12z0'},{untrustedProof:true}])
 test(`LocalSwap CREATE2 derivation refuses ${Object.keys(patch)[0]}`,()=>assert.throws(()=>deriveLocalPoolAddress({...args,...patch})));
test('CREATE2 input size and salt width are bounded',()=>{
 assert.throws(()=>deriveCreate2Address(F,'0x01','0x00'),/SALT/);assert.throws(()=>deriveCreate2Address(F,salt,'0x'+'00'.repeat(49153)),/INITCODE/);
 assert.throws(()=>deriveLocalPoolAddress({...args,poolCreationCode:'0x'+'00'.repeat(49152-95)}),/CREATION_CODE/);
});
