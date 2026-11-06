import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {keccak256,selector,address,fromHex} from '../verified/keccak.mjs';
import {FACTORY_RUNTIME_HASH,encodeCall,uintWord,decodeWords,decodeAddress} from '../verified/evm.mjs';
const vectors=JSON.parse(fs.readFileSync(new URL('./keccak-go-vectors.json',import.meta.url)));
for(const v of vectors.vectors) test(`Keccak independent Go reference: ${v.length} bytes seed ${v.seed}`,()=>{
  const bytes=Uint8Array.from({length:v.length},(_,i)=>((i*29+v.seed*17)^(i>>3)^v.seed)&255);
  assert.equal(keccak256(bytes),v.digest);
});
test('Ethereum selector is not SHA3-256',()=>assert.equal(selector('transfer(address,uint256)'),'0xa9059cbb'));
test('local runtime trust root matches bundled existing release identity',()=>{
  const original=JSON.parse(fs.readFileSync(new URL('../../src/swap/local-amm-code-identities.json',import.meta.url)));
  assert.equal(FACTORY_RUNTIME_HASH,original.factoryRuntimeCodeHash);
});
for(const value of ['0x1','0xz1',1,null,'0x'+'01'.repeat(131073)])test(`reject malformed or over-budget hash input ${typeof value}`,()=>assert.throws(()=>keccak256(value)));
for(const value of ['0x52908400098527886E0F7030069857D2E4169EE7','0x8617E340B3D01FA5F11F306F4090FD50E238070D','0xde709f2102306220921060314715629080e2fb77','0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'])test(`address canonicalization ${value}`,()=>assert.equal(address(value),value.toLowerCase()));
test('mixed case checksum typo rejected',()=>assert.throws(()=>address('0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed'),/CHECKSUM/));
test('zero token rejected',()=>assert.throws(()=>address('0x'+'0'.repeat(40)),/ADDRESS/));
test('static ABI encoder enforces arity',()=>{
  assert.throws(()=>encodeCall('getReserves()',[uintWord(1n)]),/ABI_CALL/);
  assert.throws(()=>encodeCall('quoteExactIn(address,uint256)',[]),/ABI_CALL/);
  assert.throws(()=>encodeCall('approve(address,uint256)',[]),/ABI_CALL/);
});
test('ABI decoder rejects long responses and high address bits',()=>{
  assert.throws(()=>decodeWords('0x'+uintWord(1n)+uintWord(2n),1),/RETURN/);
  assert.throws(()=>decodeAddress('0x'+uintWord(1n<<160n)),/PADDING/);
  assert.throws(()=>decodeWords('0x',100000000),/WORD_COUNT/);
  assert.throws(()=>uintWord(-1n),/UINT/);
});
