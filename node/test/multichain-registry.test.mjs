import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {registry,profile} from './multichain-fixtures.mjs';
import {makeRegistry,validateProfile,capabilities,customEvmProfile,importEvmCatalogue,FAMILIES} from '../chains/registry.mjs';
import {normalizeAsset} from '../chains/assets.mjs';
import {uint,hexUint,base58Bytes,hash64,hash32,safeEndpoint,canonical} from '../chains/core.mjs';
for(const p of registry.list())test('candidate '+p.id+' has no implicit contract or execution authorization',()=>{
 assert.equal(validateProfile(p).id,p.id);const c=capabilities(p);assert.equal(c.swapsExecutable,false);assert.equal(c.bridgesExecutable,false);assert.equal(c.liveNetworkTested,false);assert.equal(c.poolDeploymentVerified,false);assert.equal(c.walletSigning,false);assert(Object.isFrozen(p));assert(!('rpc' in p));
});
test('registry includes exactly the implemented fifteen families',()=>{assert.deepEqual([...new Set(registry.list().map(p=>p.family))].sort(),[...FAMILIES].sort());assert.equal(registry.size,138);});
for(const n of ['1','84532','9007199254740993',((1n<<256n)-1n).toString()])test('custom EVM supports exact integer '+n,()=>{const p=customEvmProfile(n);assert.equal(p.rpcIdentity,n);assert.equal(capabilities(p).swapsExecutable,false);});
for(const n of ['0','-1','01','1e3','1.0',((1n<<256n)).toString(),9007199254740992])test('bad custom id '+String(n),()=>assert.throws(()=>customEvmProfile(n)));
for(const patch of [{executable:true},{rpcIdentity:'56'},{id:'eip155:01'},{family:'malicious'},{nativeDecimals:256},{status:'audited'},{source:'javascript:alert(1)'},{name:'x\u0000y'}])test('invalid or privileged metadata '+JSON.stringify(patch),()=>assert.throws(()=>validateProfile({...profile('evm'),...patch})));
test('duplicate registry entries rejected',()=>assert.throws(()=>makeRegistry({schema:'realdex.chain-candidates.v1',profiles:[profile('evm'),profile('evm')]}),/DUPLICATE_CHAIN_ID/));
test('catalogue drops all upstream RPCs and contract addresses',()=>{
 const out=importEvmCatalogue([{chainId:999,name:'Example Mainnet',nativeCurrency:{symbol:'T',decimals:18},rpc:['http://169.254.169.254/latest/meta-data'],factory:'0xBAD',executable:true}]);
 assert.equal(out.profiles.length,1);assert.equal(out.profiles[0].environment,'unknown');assert(!JSON.stringify(out).includes('169.254'));assert(!JSON.stringify(out).includes('0xBAD'));assert(!JSON.stringify(out).includes('"executable":true'));
});
test('10,000 EVM candidates import without using network or lossy integers',()=>{
 const entries=Array.from({length:10000},(_,i)=>({chainId:String(1000000+i),name:'Fixture '+i}));const out=importEvmCatalogue(entries);assert.equal(out.profiles.length,10000);assert.equal(out.rejected.length,0);assert.equal(out.profiles.at(-1).rpcIdentity,'1009999');
});
test('catalogue records invalid entries instead of silently filling defaults',()=>{
 const out=importEvmCatalogue([{chainId:9007199254740992,name:'Lossy'},{chainId:5,name:'Fine'},{chainId:5,name:'Duplicate'},{chainId:6,name:'Fine Sepolia',nativeCurrency:{symbol:'ETH',decimals:18},status:'deprecated'}]);
 assert.equal(out.profiles.length,2);assert.equal(out.rejected.length,2);assert.equal(out.profiles[1].status,'deprecated');assert.equal(out.profiles[1].environment,'testnet');
});
test('native assets retain distinct network-bound identities',()=>{
 const a=normalizeAsset(registry.get('eip155:1'),{kind:'native'}),b=normalizeAsset(registry.get('eip155:8453'),{kind:'native'});assert.notEqual(a.key,b.key);assert.equal(a.executable,false);
});
test('ERC20 case normalization and cross-chain separation',()=>{
 const address='0x'+'Ab'.repeat(20),a=normalizeAsset(profile('evm'),{kind:'erc20',reference:address}),b=normalizeAsset(registry.get('eip155:8453'),{kind:'erc20',reference:address});assert.equal(a.reference,address.toLowerCase());assert.notEqual(a.key,b.key);
});
for(const family of FAMILIES)test(family+': native asset normalization cannot become a transfer approval',()=>assert.equal(normalizeAsset(profile(family),{kind:'native'}).executable,false));
test('move coin types preserve case-sensitive module and type names',()=>{const a=normalizeAsset(profile('sui'),{kind:'move-type',reference:'0x2::sui::SUI'});assert.equal(a.reference,'0x'+'0'.repeat(63)+'2::sui::SUI');});
test('Cosmos IBC hash vouchers stay distinct from a base denomination',()=>{assert.notEqual(normalizeAsset(profile('cosmos'),{kind:'denom',reference:'uatom'}).key,normalizeAsset(profile('cosmos'),{kind:'denom',reference:'ibc/'+'A'.repeat(64)}).key);});
test('unsupported asset abstractions fail closed',()=>{assert.throws(()=>normalizeAsset(profile('bitcoin'),{kind:'erc20',reference:'0x'+'1'.repeat(40)}));assert.throws(()=>normalizeAsset(profile('sui'),{kind:'move-type',reference:'0x2::foo::Type<0x2::sui::SUI>'}));});
for(const v of ['-1','01','1.5','NaN',Infinity,Number.MAX_SAFE_INTEGER+1])test('core integer validation '+v,()=>assert.throws(()=>uint(v)));
test('base58 zero bytes and leading zeroes are exact',()=>{assert.deepEqual(base58Bytes('1'.repeat(32)),new Uint8Array(32));assert.throws(()=>base58Bytes('0'.repeat(32)));assert.throws(()=>base58Bytes('1'.repeat(31)));});
test('base64 hash padding bits are canonical',()=>{assert.equal(hash64('A'.repeat(43)+'='),'A'.repeat(43)+'=');assert.throws(()=>hash64('A'.repeat(42)+'B='));});

test('32-byte base32 digest rejects nonzero unused padding bits',()=>{assert.equal(hash32('A'.repeat(52)),'A'.repeat(52));assert.equal(hash32('A'.repeat(51)+'Q'),'A'.repeat(51)+'Q');assert.throws(()=>hash32('A'.repeat(51)+'B'));});
