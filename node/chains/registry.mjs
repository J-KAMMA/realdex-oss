import {check,object,text,uint,freeze} from './core.mjs';
export const FAMILIES=freeze(['evm','solana','cosmos','aptos','sui','near','bitcoin','stellar','xrpl','substrate','algorand','starknet','tezos','tron','ton']);
const PIN_REQUIRED=new Set(['solana','substrate','tron','ton']);
export function validateProfile(raw) {
  object(raw,'PROFILE_INVALID');
  const keys=['id','name','family','environment','rpcIdentity','genesisHash','nativeSymbol','nativeDecimals','source','toolchain','status'];
  check(Object.keys(raw).length===keys.length&&keys.every(k=>Object.hasOwn(raw,k)),'PROFILE_SCHEMA_INVALID'); const p=structuredClone(raw);
  check(FAMILIES.includes(p.family),'FAMILY_UNSUPPORTED');
  check(typeof p.id==='string' && /^[a-z][a-z0-9-]{1,15}:[a-zA-Z0-9._-]{1,96}$/.test(p.id),'CHAIN_KEY_INVALID');
  if(p.family==='evm'){check(/^eip155:[1-9][0-9]{0,77}$/.test(p.id),'CHAIN_KEY_INVALID');check(uint(p.id.slice(7))>0n && p.rpcIdentity===p.id.slice(7),'CHAIN_ID_MISMATCH');}
  else check(p.id.startsWith(p.family+':'),'CHAIN_ID_MISMATCH');
  text(p.name,100);check(['mainnet','testnet','local','unknown'].includes(p.environment),'ENVIRONMENT_INVALID');
  check(p.rpcIdentity===null || typeof p.rpcIdentity==='string','IDENTITY_INVALID');if(p.rpcIdentity!==null)text(p.rpcIdentity,128);
  check(p.genesisHash===null || typeof p.genesisHash==='string','GENESIS_INVALID');if(p.genesisHash!==null)text(p.genesisHash,128);
  check(p.nativeSymbol===null || typeof p.nativeSymbol==='string','NATIVE_SYMBOL_INVALID');if(p.nativeSymbol!==null)text(p.nativeSymbol,24);
  check(p.nativeDecimals===null || Number.isInteger(p.nativeDecimals) && p.nativeDecimals>=0 && p.nativeDecimals<=36,'DECIMALS_INVALID');
  check(['solidity-compatibility-unverified','special-review','native-adapter-required'].includes(p.toolchain),'TOOLCHAIN_INVALID');
  check(p.status==='candidate-unverified' || p.status==='deprecated','PROFILE_CANNOT_AUTHORIZE');
  if(p.source!==null){text(p.source,512);const u=new URL(p.source);check(u.protocol==='https:'&&!u.username&&!u.password,'SOURCE_INVALID');}
  return freeze(p);
}
export function makeRegistry(data) {
  object(data);check(data.schema==='realdex.chain-candidates.v1' && Array.isArray(data.profiles) && data.profiles.length<=20000,'REGISTRY_INVALID');
  const all=data.profiles.map(validateProfile), map=new Map();
  for(const p of all){check(!map.has(p.id),'DUPLICATE_CHAIN_ID');map.set(p.id,p);}
  return freeze({list:()=>[...all],get:id=>{check(map.has(id),'CHAIN_UNKNOWN');return map.get(id);},size:all.length});
}
export function capabilities(profile) {
  const p=validateProfile(profile);
  return freeze({family:p.family,discovery:'candidate-metadata',readAdapter:'implemented-fixture-tested',
    identityPinRequired:PIN_REQUIRED.has(p.family),identityPinConfigured:!PIN_REQUIRED.has(p.family)||p.genesisHash!==null,
    genericEvmRead:p.family==='evm',existingVerifiedLabCompatible:p.family==='evm'&&p.rpcIdentity.length<=20,
    evmDeploymentPlan:p.family==='evm',nativePoolContract:p.family==='evm'?'existing-source-compile-and-deployment-required':'not-implemented',
    liveNetworkTested:false,poolDeploymentVerified:false,swapsExecutable:false,bridgesExecutable:false,walletSigning:false});
}
/** Import the public EVM catalogue as UNTRUSTED candidate metadata, never RPCs,
 * contract addresses, bridge destinations or permission to sign. No network I/O. */
export function importEvmCatalogue(entries,{source='https://github.com/ethereum-lists/chains'}={}) {
  check(Array.isArray(entries)&&entries.length>0&&entries.length<=20000,'CATALOGUE_SIZE_INVALID');
  const profiles=[],rejected=[],seen=new Set();
  for(let index=0;index<entries.length;index++){
    try{const e=object(entries[index]);const id=uint(e.chainId);check(id>0n,'CHAIN_ID_INVALID');
      const key='eip155:'+id;check(!seen.has(key),'DUPLICATE_CHAIN_ID');seen.add(key);
      const currency=e.nativeCurrency??{};text(e.name,100);
      const test=typeof e.testnet==='boolean'?e.testnet:/\b(testnet|sepolia|test|devnet|amoy|fuji|holesky|hoodi|kairos)\b/i.test(e.name);
      profiles.push(validateProfile({id:key,name:e.name,family:'evm',environment:test?'testnet':'unknown',rpcIdentity:String(id),genesisHash:null,
        nativeSymbol:typeof currency.symbol==='string'?currency.symbol:null,nativeDecimals:Number.isInteger(currency.decimals)?currency.decimals:null,
        source,toolchain:'solidity-compatibility-unverified',status:e.status==='deprecated'?'deprecated':'candidate-unverified'}));
    }catch(e){rejected.push({index,code:/^[A-Z_]+$/.test(e.message)?e.message:'ENTRY_INVALID'});}
  }
  return freeze({schema:'realdex.chain-candidates.v1',profiles,rejected,automaticRpcSelection:false,executable:false});
}
export function customEvmProfile(chainId,{name='Custom EVM',environment='unknown'}={}) {
  const id=uint(chainId);check(id>0n,'CHAIN_ID_INVALID');
  return validateProfile({id:'eip155:'+id,name,family:'evm',environment,rpcIdentity:String(id),genesisHash:null,nativeSymbol:null,nativeDecimals:null,
    source:null,toolchain:'solidity-compatibility-unverified',status:'candidate-unverified'});
}
