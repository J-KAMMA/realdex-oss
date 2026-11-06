import {check,text,uint,hashHex,hash58,base58Bytes,freeze} from './core.mjs';
import {validateProfile} from './registry.mjs';
const TYPES={evm:['erc20'],solana:['spl'],cosmos:['denom'],aptos:['move-type','fungible-asset'],sui:['move-type'],near:['nep141'],bitcoin:[],stellar:['issued'],xrpl:['issued'],substrate:['asset-id'],algorand:['asa'],starknet:['erc20'],tezos:['fa12','fa2'],tron:['trc20'],ton:['jetton']};
/** Canonical, chain-bound asset keys. Syntactic normalization only, NOT account
 * ownership, issuer/transfer safety, NFT/fungibility verification or bridge equivalence. */
export function normalizeAsset(profile,raw) {
 const p=validateProfile(profile);check(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).every(k=>['kind','reference','tokenId'].includes(k)),'ASSET_INVALID');
 const kind=raw.kind;check(kind==='native'||TYPES[p.family].includes(kind),'ASSET_KIND_UNSUPPORTED');
 if(kind==='native'){check(!Object.hasOwn(raw,'reference')&&!Object.hasOwn(raw,'tokenId'),'NATIVE_ASSET_AMBIGUOUS');return freeze({chainId:p.id,kind,reference:null,tokenId:null,key:p.id+'/native',executable:false});}
 let ref=text(raw.reference,256),tokenId=null;
 if(p.family==='evm'){check(/^0x[0-9a-fA-F]{40}$/.test(ref)&&!/^0x0{40}$/i.test(ref),'ASSET_ADDRESS_INVALID');ref=ref.toLowerCase();}
 else if(p.family==='solana')hash58(ref);
 else if(p.family==='cosmos'){check(/^[a-zA-Z][a-zA-Z0-9/:._-]{2,255}$/.test(ref),'DENOM_INVALID');if(ref.startsWith('ibc/'))check(/^ibc\/[0-9A-F]{64}$/.test(ref),'IBC_DENOM_INVALID');}
 else if(['sui','aptos'].includes(p.family)){
  if(kind==='fungible-asset')ref=hashHex(ref);
  else {check(/^0x[0-9a-fA-F]{1,64}::[a-zA-Z_][a-zA-Z0-9_]*::[a-zA-Z_][a-zA-Z0-9_]*$/.test(ref),'MOVE_TYPE_UNSUPPORTED');const parts=ref.split('::');parts[0]='0x'+parts[0].slice(2).toLowerCase().padStart(64,'0');ref=parts.join('::');}
 }else if(p.family==='near')check(/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)$/.test(ref)&&ref.length>=2&&ref.length<=64,'ACCOUNT_ID_INVALID');
 else if(p.family==='stellar'){const [code,issuer,...rest]=ref.split(':');check(!rest.length&&/^[a-zA-Z0-9]{1,12}$/.test(code)&&/^G[A-Z2-7]{55}$/.test(issuer),'ISSUED_ASSET_INVALID');}
 else if(p.family==='xrpl'){const [code,issuer,...rest]=ref.split(':');check(!rest.length&&(/^[A-Za-z0-9]{3}$/.test(code)&&code!=='XRP'||/^[A-Fa-f0-9]{40}$/.test(code))&&/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(issuer),'ISSUED_ASSET_INVALID');if(code.length===40)ref=code.toUpperCase()+':'+issuer;}
 else if(['substrate','algorand'].includes(p.family)){const n=uint(ref,(1n<<64n)-1n);check(p.family!=='algorand'||n>0n,'ASA_ID_INVALID');ref=String(n);}
 else if(p.family==='starknet'){check(/^0x[0-9a-fA-F]{1,64}$/.test(ref),'ASSET_ADDRESS_INVALID');const n=BigInt(ref);check(n>0n&&n<(1n<<251n),'ASSET_ADDRESS_INVALID');ref='0x'+n.toString(16);}
 else if(p.family==='tezos'){check(/^KT1[1-9A-HJ-NP-Za-km-z]{33}$/.test(ref),'ASSET_ADDRESS_INVALID');if(kind==='fa2')tokenId=String(uint(raw.tokenId));}
 else if(p.family==='tron'){if(/^41[0-9a-fA-F]{40}$/.test(ref))ref=ref.toLowerCase();else{check(/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(ref),'ASSET_ADDRESS_INVALID');base58Bytes(ref,25);}}
 else if(p.family==='ton'){check(/^(?:-1|0):[0-9a-fA-F]{64}$/.test(ref),'TON_RAW_ADDRESS_REQUIRED');ref=ref.toLowerCase();}
 if(kind!=='fa2')check(!Object.hasOwn(raw,'tokenId'),'TOKEN_ID_UNEXPECTED');
 // JSON-based key avoids delimiter collisions; no ticker-based equivalence.
 return freeze({chainId:p.id,kind,reference:ref,tokenId,key:JSON.stringify([p.id,kind,ref,tokenId]),executable:false});
}
