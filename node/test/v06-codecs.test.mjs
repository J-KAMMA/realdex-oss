import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {principalBytes,principalText,canisterPrincipal,icrcAccount,icrcAsset,crc32} from '../icp/principal.mjs';
import {encodeCbor,decodeCbor} from '../icp/cbor.mjs';
import {encodeIcrcReadArgs,decodeIcrcReadReply,READ_METHODS} from '../icp/candid.mjs';
import {parseExactJson} from '../extended/json.mjs';
import {vectors,ICP,CKBTC} from './v06-fixtures.mjs';
const bytes=h=>new Uint8Array(Buffer.from(h,'hex'));
test('Principal: 90 independent Python CRC32/base32 vectors including all lengths 0..29',()=>{
 const cases=JSON.parse(fs.readFileSync(new URL('./v06-principal-vectors.json',import.meta.url))).vectors;assert.equal(cases.length,90);
 for(const v of cases){assert.equal(principalText(bytes(v.hex)),v.text);assert.equal(Buffer.from(principalBytes(v.text)).toString('hex'),v.hex);}
});
test('Principal: well-known anonymous, management and ledger IDs',()=>{assert.equal(principalText(new Uint8Array()),'aaaaa-aa');assert.equal(principalText(new Uint8Array([4])),'2vxsx-fae');assert.equal(canisterPrincipal(ICP),ICP);assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);});
for(const s of ['2vxsx-faa','aaa-aaaa','aaaaa-aaa','aaaaa-aa-','0aaaa-aa','a'.repeat(64),'aaaaa-aa\n'])test('Principal: rejects malformed '+JSON.stringify(s),()=>assert.throws(()=>principalBytes(s)));
test('Principal: zero and absent subaccount are the same account',()=>{assert.deepEqual(icrcAccount({owner:ICP}),icrcAccount({owner:ICP.toUpperCase(),subaccount:'0'.repeat(64)}));assert.throws(()=>icrcAccount({owner:ICP,subaccount:'00'}));assert.throws(()=>canisterPrincipal('2vxsx-fae'));assert.throws(()=>canisterPrincipal('aaaaa-aa'));});
test('ICP assets separate ledgers and local networks; no wrapped/native equivalence',()=>{assert.notEqual(icrcAsset('icp:mainnet',ICP).key,icrcAsset('icp:mainnet',CKBTC).key);assert.notEqual(icrcAsset('icp:mainnet',ICP).key,icrcAsset('icp:local-test',ICP).key);assert.throws(()=>icrcAsset('eip155:1',ICP));});
for(const [name,hex] of Object.entries(vectors))test('Candid independent golden vector '+name,()=>{const v=decodeIcrcReadReply(name,bytes(hex));if(name==='icrc1_fee')assert.equal(v,'10000');if(name==='icrc1_decimals')assert.equal(v,8);if(name==='icrc1_total_supply')assert.equal(v,String((1n<<80n)+17n));if(name==='icrc1_symbol')assert.equal(v,'ICP');if(name==='icrc1_supported_standards')assert.deepEqual(v.map(x=>x.name),['ICRC-1','ICRC-2']);});
test('Candid empty args and canonical account encoding are fixed and bounded',()=>{for(const m of READ_METHODS.filter(x=>x!=='icrc1_balance_of'))assert.equal(Buffer.from(encodeIcrcReadArgs(m)).toString('hex'),'4449444c0000');
 assert.deepEqual(encodeIcrcReadArgs('icrc1_balance_of',{account:{owner:ICP}}),encodeIcrcReadArgs('icrc1_balance_of',{account:{owner:ICP,subaccount:'0'.repeat(64)}}));});
for(const method of ['icrc1_transfer','icrc2_approve','icrc2_transfer_from','mint','get_minter_info'])test('Candid codec excludes '+method,()=>assert.throws(()=>encodeIcrcReadArgs(method),/FORBIDDEN/));
test('Candid refuses extra parameters and type confusion',()=>{assert.throws(()=>encodeIcrcReadArgs('icrc1_fee',{secret:'s'}));assert.throws(()=>decodeIcrcReadReply('icrc1_fee',bytes(vectors.icrc1_symbol)),/TYPE/);assert.throws(()=>decodeIcrcReadReply('icrc1_symbol',bytes('4449444c00017103fffeff')));});
for(const bad of ['','4449444c0000','4449444c00017d80','4449444c00017d'+('80'.repeat(148)),'4449444c01000100','4449444c00017d0100','4449444c026d016d00010000'])test('Candid invalid/truncated/cyclic '+bad.slice(0,35),()=>assert.throws(()=>decodeIcrcReadReply('icrc1_fee',bytes(bad))));
const cb=[null,true,false,0n,23n,24n,255n,256n,65535n,65536n,4294967296n,(1n<<64n)-1n,-1n,-25n,'日本語',new Uint8Array([0,255]),['x',1n],{content:{method:'icrc1_fee',arg:new Uint8Array()}}];
for(let i=0;i<cb.length;i++)test('CBOR supported value '+i,()=>assert.deepEqual(decodeCbor(encodeCbor(cb[i])),cb[i]));
for(const hex of ['a2616101616102','a1695f5f70726f746f5f5f01','9fff','7fff','c06161','f97e00','1801ff','d9d9f7d9d9f700','581000'])test('CBOR malformed/unsupported '+hex,()=>assert.throws(()=>decodeCbor(bytes(hex))));
test('CBOR refuses encoding unsafe integers and overly large responses',()=>{assert.throws(()=>encodeCbor(9007199254740992));assert.throws(()=>encodeCbor(1n<<64n));assert.throws(()=>decodeCbor(new Uint8Array(1025),{maxBytes:1024}));assert.throws(()=>decodeCbor(bytes('81818181818100'),{maxDepth:3}));});
test('Exact JSON never rounds 128-bit Monero counters or decimal Zcash amounts',()=>{
 const r=parseExactJson('{"wide":340282366920938463463374607431768211455,"amount":0.00000001,"id":1,"ok":false}');assert.equal(r.wide,'340282366920938463463374607431768211455');assert.equal(r.amount,'0.00000001');assert.equal(r.id,'1');assert.equal(r.ok,false);
});
for(const s of ['{"a":1,"a":2}','{"__proto__":{}}','[1,]','01','1e99999x','"\\ud800"','{"x":1}x','"\n"'])test('Exact JSON invalid '+JSON.stringify(s),()=>assert.throws(()=>parseExactJson(s)));
test('Exact JSON bounded depth, nodes and whitespace',()=>{assert.deepEqual(parseExactJson(' \n[true, null, "a\\\"b", {"x":"\\u65e5"}]\t'),[true,null,'a"b',{x:'日'}]);assert.throws(()=>parseExactJson('[[[[[0]]]]]',{maxDepth:2}));assert.throws(()=>parseExactJson('[1,2,3]',{maxNodes:2}));});
test('Candid balance args match independent Python account wire encoder',()=>{const v=JSON.parse(fs.readFileSync(new URL('./v06-account-vector.json',import.meta.url)));assert.equal(Buffer.from(encodeIcrcReadArgs('icrc1_balance_of',{account:{owner:v.owner,subaccount:v.subaccount}})).toString('hex'),v.hex);});
