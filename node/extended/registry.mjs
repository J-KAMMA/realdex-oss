import {check,keys,text,uint,freeze} from './guard.mjs';
import {hashHex} from '../chains/core.mjs';
export const EXTENDED_FAMILIES=Object.freeze(['icp','monero','utxo-core','cometbft','evm']);
const COINS=['zcash','litecoin','dogecoin','bitcoin-cash','dash'];
export function validateExtendedProfile(raw){
 keys(raw,['id','name','family','environment','networkIdentity','nativeSymbol','nativeDecimals','privacyModel','restricted','genesisHash','source','status']);
 const p=structuredClone(raw);check(EXTENDED_FAMILIES.includes(p.family),'FAMILY_UNSUPPORTED');
 check(typeof p.id==='string'&&/^[a-z][a-z0-9-]{1,15}:[a-zA-Z0-9._-]{1,80}$/.test(p.id),'NETWORK_ID_INVALID');
 text(p.name,100);check(['mainnet','testnet','local'].includes(p.environment),'ENVIRONMENT_INVALID');
 text(p.networkIdentity,128);text(p.nativeSymbol,16);check(Number.isInteger(p.nativeDecimals)&&p.nativeDecimals>=0&&p.nativeDecimals<=36,'DECIMALS_INVALID');
 check(['public','optional-shielded','shielded','confidential-contracts','permissioned-not-confidential'].includes(p.privacyModel),'PRIVACY_MODEL_INVALID');
 check(typeof p.restricted==='boolean','RESTRICTED_FLAG_INVALID');check(p.genesisHash===null||typeof p.genesisHash==='string','GENESIS_INVALID');
 if(p.genesisHash!==null)hashHex(p.genesisHash,false);check(p.status==='candidate-unverified','PROFILE_CANNOT_AUTHORIZE');
 const ns=p.id.split(':')[0];if(p.family==='icp')check(ns==='icp'&&/^icp:(mainnet|local-[a-z0-9-]{1,48})$/.test(p.id),'NETWORK_ID_INVALID');
 if(p.family==='monero')check(ns==='monero'&&['mainnet','testnet','stagenet'].includes(p.networkIdentity)&&p.id==='monero:'+p.networkIdentity,'NETWORK_ID_INVALID');
 if(p.family==='utxo-core'){const suffix=p.id.slice(ns.length+1);check(COINS.includes(ns)&&Object.hasOwn({mainnet:'main',testnet:'test',regtest:'regtest'},suffix)&&p.networkIdentity===({mainnet:'main',testnet:'test',regtest:'regtest'})[suffix],'NETWORK_ID_INVALID');}
 if(p.family==='cometbft')check(['cosmos','namada','penumbra','private-cosmos'].includes(ns),'NETWORK_ID_INVALID');
 if(p.family==='evm'){check(['eip155','private-evm'].includes(ns),'NETWORK_ID_INVALID');uint(p.networkIdentity);if(ns==='eip155')check(p.id==='eip155:'+p.networkIdentity,'NETWORK_ID_INVALID');}
 check(p.restricted===ns.startsWith('private-'),'PRIVATE_NAMESPACE_REQUIRED');
 if(ns.startsWith('private-'))check(p.restricted&&p.genesisHash!==null,'PRIVATE_GENESIS_PIN_REQUIRED');
 if(p.restricted)check(p.privacyModel==='permissioned-not-confidential','PERMISSIONED_NOT_SHIELDED');
 text(p.source,512);const u=new URL(p.source);check(u.protocol==='https:'&&!u.username&&!u.password,'SOURCE_INVALID');return freeze(p);
}
export function extendedRegistry(data){keys(data,['schema','profiles']);check(data.schema==='realdex.extended-networks.v1'&&Array.isArray(data.profiles)&&data.profiles.length<=2048,'REGISTRY_INVALID');
 const profiles=data.profiles.map(validateExtendedProfile),map=new Map();for(const p of profiles){check(!map.has(p.id),'DUPLICATE_NETWORK');map.set(p.id,p);}
 return Object.freeze({size:map.size,list:()=>[...profiles],get:id=>{check(map.has(id),'NETWORK_UNKNOWN');return map.get(id);}});
}
export function privateEvmProfile({slug,chainId,genesisHash,name='Private EVM'}){
 check(typeof slug==='string'&&/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug),'PRIVATE_SLUG_INVALID');const id=uint(chainId);check(id>0n,'CHAIN_ID_INVALID');
 return validateExtendedProfile({id:'private-evm:'+slug,name,family:'evm',environment:'local',networkIdentity:String(id),nativeSymbol:'LOCAL',nativeDecimals:18,
  privacyModel:'permissioned-not-confidential',restricted:true,genesisHash:hashHex(genesisHash,false),source:'https://docs.besu-eth.org/private-networks/concepts/permissioning',status:'candidate-unverified'});
}
export function privateCometProfile({slug,chainId,checkpointHash,name='Private CometBFT'}){
 check(typeof slug==='string'&&/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug),'PRIVATE_SLUG_INVALID');text(chainId,100);
 return validateExtendedProfile({id:'private-cosmos:'+slug,name,family:'cometbft',environment:'local',networkIdentity:chainId,nativeSymbol:'LOCAL',nativeDecimals:6,
  privacyModel:'permissioned-not-confidential',restricted:true,genesisHash:hashHex(checkpointHash,false),source:'https://docs.cometbft.com/v0.38/rpc/',status:'candidate-unverified'});
}
export function extendedCapabilities(profile){const p=validateExtendedProfile(profile);return freeze({readProtocol:p.family==='icp'?'ledger-scoped-rosetta-and-candid':p.family,
  defaultAccess:'literal-loopback-only',remoteRequiresOriginConsent:true,privacyModel:p.privacyModel,permissioned:p.restricted,
  peerDiscoveryForPrivateNetworks:false,viewingKeyAccess:false,spendingKeyAccess:false,shieldedWalletScan:false,privacyProofsVerified:false,
  poolContractImplemented:false,swapsExecutable:false,bridgesExecutable:false,liveNetworkTested:false});}
